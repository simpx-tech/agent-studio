import { describe, it, expect } from 'vitest';
import { initialWorkspace, restoreWorkspace, settingsFor, type Conversation } from './domain';
import { registerInstallation, registerWslEnvironments } from './fleet';
import {
  conversationLocation,
  ensureLocationConnections,
  groupConversations,
  knownLocations,
  locationConnections,
  loginIdentity,
  nextActiveConversation,
  rememberLocation,
  computerFolderEnvironments,
  scratchLocation,
  type LoginIdentity,
} from './locations';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';

function fixture() {
  const workspace = initialWorkspace();
  const installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'Desktop',
    platform: 'windows' as const,
  };
  registerInstallation(workspace.fleet, installation);
  const wsl = crypto.randomUUID();
  registerWslEnvironments(workspace.fleet, installation, {
    distributions: [{ id: wsl, name: 'Ubuntu', running: true }],
    warning: null,
  });
  const location = {
    computerId: installation.computerId,
    environmentId: wsl,
    path: '/home/test/project',
  };
  return { workspace, installation, location };
}
describe('computer and folder chat scope', () => {
  it('uses the selected computer for the same WSL folder and preserves both routes across storage and sync', () => {
    const { workspace, installation, location } = fixture();
    const desktopFolder = { ...location, executionEnvironmentId: installation.id };
    ensureLocationConnections(workspace.fleet, desktopFolder);
    ensureLocationConnections(workspace.fleet, location);
    const windowsConnections = locationConnections(workspace.fleet, desktopFolder);
    expect(windowsConnections).toHaveLength(3);
    expect(windowsConnections.every((c) => c.environmentId === installation.id)).toBe(true);
    expect(
      locationConnections(workspace.fleet, location).every(
        (c) => c.environmentId === location.environmentId,
      ),
    ).toBe(true);
    expect(
      computerFolderEnvironments(workspace.fleet, installation.computerId).map((e) => e.id),
    ).toEqual([installation.id, location.environmentId]);
    expect(
      computerFolderEnvironments(workspace.fleet, location.environmentId).map((e) => e.id),
    ).toEqual([location.environmentId]);
    rememberLocation(workspace, desktopFolder);
    rememberLocation(workspace, location);
    expect(knownLocations(workspace, installation.computerId)).toEqual([desktopFolder]);
    expect(knownLocations(workspace, location.environmentId)).toEqual([location]);
    const base: Conversation = {
      id: crypto.randomUUID(),
      settings: { ...settingsFor(workspace.preferences), connectionId: windowsConnections[0].id },
      location: desktopFolder,
      title: 'Desktop agent',
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    workspace.conversations = [
      base,
      { ...base, id: crypto.randomUUID(), location, title: 'Linux agent' },
    ];
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[0].location).toEqual(desktopFolder);
    expect(
      mergeShared(emptyShared(), sharedWorkspace(restored), emptyShared()).conversations[0]
        .location,
    ).toEqual(desktopFolder);
    expect(
      groupConversations(restored.conversations, restored.fleet)[0].computers.map((c) => c.name),
    ).toEqual(['Desktop', 'WSL · Ubuntu']);
    const sibling = crypto.randomUUID();
    registerWslEnvironments(workspace.fleet, installation, {
      distributions: [{ id: sibling, name: 'Debian', running: true }],
      warning: null,
    });
    expect(
      locationConnections(workspace.fleet, { ...location, executionEnvironmentId: sibling }),
    ).toEqual([]);
    expect(() =>
      ensureLocationConnections(workspace.fleet, {
        ...location,
        executionEnvironmentId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
  it('pins existing logins to a folder environment without duplicating connections or profiles', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    ensureLocationConnections(workspace.fleet, location);
    const native = { ...location, environmentId: installation.id, path: 'C:\\project' };
    ensureLocationConnections(workspace.fleet, native);
    expect(locationConnections(workspace.fleet, location)).toHaveLength(2);
    expect(locationConnections(workspace.fleet, location, 'gemini')).toHaveLength(0);
    expect(locationConnections(workspace.fleet, native)).toHaveLength(3);
    expect(
      locationConnections(workspace.fleet, { ...location, computerId: crypto.randomUUID() }),
    ).toEqual([]);
    expect(workspace.fleet.connections.every((c) => c.profile === 'existing')).toBe(true);
    expect(() =>
      ensureLocationConnections(workspace.fleet, {
        ...location,
        environmentId: crypto.randomUUID(),
      }),
    ).toThrow();
  });
  it('keeps a terminal login out while another profile of the same account is connected there', () => {
    const { workspace, installation } = fixture();
    const native = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    };
    const profile = {
      id: crypto.randomUUID(),
      name: 'vinporb',
      provider: 'claude' as const,
      purpose: 'personal' as const,
    };
    const isolated = {
      id: crypto.randomUUID(),
      environmentId: installation.id,
      accountId: profile.id,
      profile: 'isolated' as const,
    };
    workspace.fleet.accounts.push(profile);
    workspace.fleet.connections.push(isolated);
    const identities = (login: LoginIdentity, connections: Record<string, LoginIdentity>) => ({
      login: (_environmentId: string, provider: string) => (provider === 'claude' ? login : null),
      connection: (id: string) => connections[id],
    });
    const claude = () => locationConnections(workspace.fleet, native, 'claude');
    const labels = () =>
      workspace.fleet.accounts.filter((a) => a.provider === 'claude').map((a) => a.name);
    // An unchecked login waits for the CLI's report while the agent is already offered here.
    ensureLocationConnections(workspace.fleet, native, identities(undefined, {}));
    expect(claude()).toEqual([isolated]);
    expect(locationConnections(workspace.fleet, native, 'codex')).toHaveLength(1);
    // The terminal login is the connected profile's own account: nothing to add.
    ensureLocationConnections(
      workspace.fleet,
      native,
      identities('vinporb@example.com', { [isolated.id]: 'vinporb@example.com' }),
    );
    expect(claude()).toEqual([isolated]);
    // A sibling whose identity is still unresolved also defers the decision.
    ensureLocationConnections(workspace.fleet, native, identities('other@example.com', {}));
    expect(claude()).toEqual([isolated]);
    expect(labels()).toEqual(['vinporb']);
    // A different signed-in account becomes the CLI login connection.
    ensureLocationConnections(
      workspace.fleet,
      native,
      identities('other@example.com', { [isolated.id]: 'vinporb@example.com' }),
    );
    const login = claude().find((c) => c.profile === 'existing');
    expect(login).toBeDefined();
    expect(labels()).toEqual(['vinporb', 'Claude CLI login']);
    // Removing that connection leaves its label; a signed-out terminal login reuses the label
    // instead of creating another one.
    workspace.fleet.connections = workspace.fleet.connections.filter((c) => c.id !== login!.id);
    ensureLocationConnections(
      workspace.fleet,
      native,
      identities(null, { [isolated.id]: 'vinporb@example.com' }),
    );
    expect(
      claude()
        .map((c) => c.profile)
        .sort(),
    ).toEqual(['existing', 'isolated']);
    expect(labels()).toEqual(['vinporb', 'Claude CLI login']);
    expect(claude().find((c) => c.profile === 'existing')?.accountId).toBe(
      workspace.fleet.accounts.find((a) => a.name === 'Claude CLI login')?.id,
    );
  });
  it('does not register a terminal login again after it became a separate profile without an identity', () => {
    const { workspace, installation } = fixture();
    const native = { computerId: installation.computerId, environmentId: installation.id, path: '' };
    const account = {
      id: crypto.randomUUID(),
      name: 'vinicius.portela.stm',
      provider: 'codex' as const,
      purpose: 'personal' as const,
    };
    const separated = {
      id: crypto.randomUUID(),
      environmentId: installation.id,
      accountId: account.id,
      profile: 'isolated' as const,
      sharedContext: 'none' as const,
      fromTerminalLogin: true,
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(separated);
    // Codex reports no login identity: the marker stands in for the matching identity.
    const identities = { login: () => null, connection: () => null };
    ensureLocationConnections(workspace.fleet, native, identities);
    expect(locationConnections(workspace.fleet, native, 'codex')).toEqual([separated]);
    delete (separated as { fromTerminalLogin?: boolean }).fromTerminalLogin;
    ensureLocationConnections(workspace.fleet, native, identities);
    expect(locationConnections(workspace.fleet, native, 'codex')).toHaveLength(2);
  });
  it('connects another environment’s terminal login under the account that already reports it', () => {
    const { workspace, installation, location } = fixture();
    const profile = {
      id: crypto.randomUUID(),
      name: 'vinporb',
      provider: 'claude' as const,
      purpose: 'personal' as const,
    };
    const isolated = {
      id: crypto.randomUUID(),
      environmentId: installation.id,
      accountId: profile.id,
      profile: 'isolated' as const,
    };
    workspace.fleet.accounts.push(profile);
    workspace.fleet.connections.push(isolated);
    ensureLocationConnections(workspace.fleet, location, {
      login: (environmentId, provider) =>
        provider === 'claude' && environmentId === location.environmentId
          ? 'vinporb@example.com'
          : null,
      connection: (id) => (id === isolated.id ? 'vinporb@example.com' : null),
    });
    const wsl = locationConnections(workspace.fleet, location, 'claude');
    expect(wsl).toHaveLength(1);
    expect(wsl[0]).toMatchObject({ accountId: profile.id, profile: 'existing' });
    expect(workspace.fleet.accounts.filter((a) => a.provider === 'claude')).toHaveLength(1);
    expect(workspace.fleet.accounts.find((a) => a.provider === 'codex')?.name).toBe(
      'Codex CLI login',
    );
    expect(loginIdentity(undefined)).toBeUndefined();
    expect(loginIdentity({ auth: 'unknown', account: 'a@b' })).toBeUndefined();
    expect(loginIdentity({ auth: 'login', account: 'a@b' })).toBeNull();
    expect(loginIdentity({ auth: 'ready' })).toBeNull();
    expect(loginIdentity({ auth: 'ready', account: '  a@b ' })).toBe('a@b');
  });
  it('restores folders and archived messages and groups identical names independently by computer', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [],
    };
    const other = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'Laptop',
      platform: 'linux' as const,
    };
    registerInstallation(workspace.fleet, other);
    workspace.conversations = [
      conversation,
      { ...conversation, id: crypto.randomUUID(), archived: true },
      {
        ...conversation,
        id: crypto.randomUUID(),
        location: { ...location, computerId: other.computerId, environmentId: other.id },
      },
    ];
    rememberLocation(workspace, location);
    rememberLocation(workspace, location);
    expect(knownLocations(workspace, installation.computerId)).toHaveLength(0);
    expect(knownLocations(workspace, location.environmentId)).toHaveLength(1);
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[1].archived).toBe(true);
    const groups = groupConversations(restored.conversations, restored.fleet, installation);
    expect(groups[0].computers.map((c) => c.name)).toEqual(['WSL · Ubuntu', 'Laptop']);
    expect(restored.conversations[0].location).toEqual(location);
    expect(groups[0].computers[0].folders[0].name).toBe('project');
    expect(groups[1].count).toBe(1);
    const legacy = { ...conversation, location: undefined };
    expect(conversationLocation(legacy, workspace.fleet, installation)?.path).toBe('');
    expect(
      conversationLocation(
        { ...legacy, settings: { ...legacy.settings, connectionId: crypto.randomUUID() } },
        workspace.fleet,
        installation,
      ),
    ).toBeUndefined();
  });
  it('lists scratch chats first in their Active folder and in folders of their own afterwards', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [],
    };
    const scratches = [
      { id: 'same folder', computerId: location.environmentId, location },
      // Without a folder yet, a scratch chat waits in its computer's Standalone group.
      { id: 'no folder', computerId: installation.computerId },
      { id: 'unknown computer', computerId: crypto.randomUUID() },
    ];
    const [active, history] = groupConversations(
      [conversation, { ...conversation, id: crypto.randomUUID(), archived: true }],
      workspace.fleet,
      installation,
      scratches,
    );
    expect(
      active.computers.map((c) => [
        c.name,
        c.folders.map((f) => [f.name, f.scratches.map((s) => s.id), f.conversations.length]),
      ]),
    ).toEqual([
      ['WSL · Ubuntu', [['project', ['same folder'], 1]]],
      ['Desktop', [['Standalone', ['no folder'], 0]]],
      ['Unavailable computer', [['Standalone', ['unknown computer'], 0]]],
    ]);
    // Scratch chats are not conversations: they are not counted and never join History.
    expect(active.count).toBe(1);
    expect(history.computers.flatMap((c) => c.folders.flatMap((f) => f.scratches))).toEqual([]);
    expect(scratchLocation(workspace.fleet, scratches[1])).toEqual({
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    });
    expect(scratchLocation(workspace.fleet, scratches[0])).toBe(location);
    expect(scratchLocation(workspace.fleet, scratches[2])).toBeUndefined();
  });
  it('moves on to the Active conversation listed below a chat leaving Active, else the one above', () => {
    const { workspace, installation, location } = fixture();
    ensureLocationConnections(workspace.fleet, location);
    const chat = (title: string, place = location, archived = false): Conversation => ({
      id: title,
      settings: settingsFor(workspace.preferences),
      location: place,
      title,
      createdAt: '',
      updatedAt: '',
      messages: [],
      ...(archived ? { archived } : {}),
    });
    const standalone = {
      computerId: installation.computerId,
      environmentId: installation.id,
      path: '',
    };
    const conversations = [
      chat('first'),
      chat('archived', location, true),
      chat('second'),
      chat('standalone', standalone),
    ];
    const groups = groupConversations(conversations, workspace.fleet, installation, [
      { id: 'scratch', computerId: installation.computerId, location: standalone },
    ]);
    const next = (id: string) => nextActiveConversation(groups, id)?.id;
    // The listed order crosses folders and computers; History and scratch chats are skipped.
    expect(next('first')).toBe('second');
    expect(next('second')).toBe('standalone');
    expect(next('standalone')).toBe('second');
    expect(next('archived')).toBeUndefined();
    expect(next('unknown')).toBeUndefined();
    const alone = groupConversations([chat('only')], workspace.fleet, installation);
    expect(nextActiveConversation(alone, 'only')).toBeUndefined();
  });

  it('syncs archiving and never loses a concurrent location or history edit during run reconciliation', () => {
    const { workspace, installation, location } = fixture();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      location,
      title: 'Chat',
      createdAt: '',
      updatedAt: '',
      messages: [
        {
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          role: 'assistant',
          status: 'complete',
          blocks: [],
          createdAt: '',
        },
      ],
    };
    workspace.conversations.push(conversation);
    const base = sharedWorkspace(workspace);
    const archived = structuredClone(base);
    archived.conversations[0].archived = true;
    expect(mergeShared(base, archived, base).conversations[0].archived).toBe(true);
    const remote = structuredClone(base);
    remote.conversations[0].location!.path = '/another/project';
    const merged = mergeShared(base, archived, remote);
    expect(merged.conversations).toHaveLength(2);
    expect(merged.conversations.some((c) => c.archived)).toBe(true);
    expect(groupConversations(merged.conversations, workspace.fleet, installation)[1].count).toBe(
      1,
    );
    expect(mergeShared(emptyShared(), base, emptyShared()).conversations[0].location).toEqual(
      location,
    );
  });
});
