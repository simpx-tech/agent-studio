import {
  providerIds,
  type ChatLocation,
  type Conversation,
  type ProviderId,
  type Workspace,
} from './domain';
import type { Fleet, Installation } from './fleet';

export const locationKey = (location: ChatLocation) =>
  `${location.computerId}/${location.environmentId}/${location.path}`;
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

// A location pins a native/WSL environment; it never uses automatic cross-environment fallback.
export function ensureLocationConnections(fleet: Fleet, location: ChatLocation) {
  const environment = fleet.environments.find(
    (e) => e.id === location.environmentId && e.computerId === location.computerId,
  );
  if (!environment) throw new Error('This folder’s environment is no longer available.');
  for (const provider of providerIds) {
    if (environment.platform === 'wsl' && environment.discoveredOn && provider === 'gemini')
      continue;
    if (
      fleet.connections.some(
        (c) =>
          c.environmentId === environment.id &&
          c.profile === 'existing' &&
          fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
      )
    )
      continue;
    const account = {
      id: crypto.randomUUID(),
      name: `${provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Gemini'} CLI login`,
      provider,
      purpose: 'personal' as const,
    };
    fleet.accounts.push(account);
    fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId: environment.id,
      accountId: account.id,
      profile: 'existing',
    });
  }
}
export function locationConnections(fleet: Fleet, location?: ChatLocation, provider?: ProviderId) {
  if (!location) return [];
  const environment = fleet.environments.find(
    (e) => e.id === location.environmentId && e.computerId === location.computerId,
  );
  if (!environment) return [];
  return fleet.connections.filter(
    (c) =>
      c.environmentId === environment.id &&
      fleet.accounts.some((a) => a.id === c.accountId && (!provider || a.provider === provider)),
  );
}
export function rememberLocation(workspace: Workspace, location: ChatLocation) {
  workspace.preferences.recentLocations = [
    location,
    ...(workspace.preferences.recentLocations ?? []).filter(
      (l) => locationKey(l) !== locationKey(location),
    ),
  ].slice(0, 30);
}
export function knownLocations(workspace: Workspace, computerId: string) {
  const values = [
    ...(workspace.preferences.recentLocations ?? []),
    ...workspace.conversations.flatMap((c) => (c.location?.path ? [c.location] : [])),
  ];
  return [
    ...new Map(
      values
        .filter(
          (l) => l.computerId === computerId && locationConnections(workspace.fleet, l).length,
        )
        .map((l) => [locationKey(l), l]),
    ).values(),
  ];
}
export function conversationLocation(
  conversation: Conversation,
  fleet: Fleet,
  installation?: Installation,
): ChatLocation | undefined {
  if (conversation.location) return conversation.location;
  const connection = fleet.connections.find((c) => c.id === conversation.settings.connectionId);
  const environment = fleet.environments.find(
    (e) =>
      e.id ===
      (connection?.environmentId ??
        (!conversation.settings.connectionId ? installation?.id : undefined)),
  );
  return environment
    ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
    : undefined;
}
export function groupConversations(
  conversations: Conversation[],
  fleet: Fleet,
  installation?: Installation,
) {
  return ([false, true] as const).map((archived) => {
    const computers = new Map<
      string,
      {
        id: string;
        name: string;
        folders: Map<
          string,
          {
            id: string;
            name: string;
            detail: string;
            location?: ChatLocation;
            conversations: Conversation[];
          }
        >;
      }
    >();
    for (const conversation of conversations.filter((c) => !!c.archived === archived)) {
      const location = conversationLocation(conversation, fleet, installation);
      const computerId = location?.computerId ?? 'unassigned';
      if (!computers.has(computerId))
        computers.set(computerId, {
          id: computerId,
          name: fleet.computers.find((c) => c.id === computerId)?.name ?? 'Unavailable computer',
          folders: new Map(),
        });
      const computer = computers.get(computerId)!;
      const key = location ? locationKey(location) : 'unassigned';
      const environment = fleet.environments.find((e) => e.id === location?.environmentId);
      if (!computer.folders.has(key))
        computer.folders.set(key, {
          id: key,
          name: location?.path ? folderName(location.path) : 'No folder',
          detail: `${environment?.name ?? 'Unavailable environment'}${location?.path ? ` · ${location.path}` : ''}`,
          location: location ? { ...location } : undefined,
          conversations: [],
        });
      computer.folders.get(key)!.conversations.push(conversation);
    }
    return {
      id: archived ? 'history' : 'active',
      name: archived ? 'History' : 'Active',
      count: conversations.filter((c) => !!c.archived === archived).length,
      computers: [...computers.values()].map((c) => ({ ...c, folders: [...c.folders.values()] })),
    };
  });
}
