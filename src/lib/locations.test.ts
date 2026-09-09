import { describe, it, expect } from 'vitest';
import { initialWorkspace, restoreWorkspace, settingsFor, type Conversation } from './domain';
import { registerInstallation, registerWslEnvironments } from './fleet';
import {
  conversationLocation,
  ensureLocationConnections,
  groupConversations,
  knownLocations,
  locationConnections,
  rememberLocation,
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
    expect(knownLocations(workspace, installation.computerId)).toHaveLength(1);
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[1].archived).toBe(true);
    const groups = groupConversations(restored.conversations, restored.fleet, installation);
    expect(groups[0].computers.map((c) => c.name)).toEqual(['Desktop', 'Laptop']);
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
