import {
  providerIds,
  type ChatLocation,
  type Conversation,
  type ProviderId,
  type Workspace,
} from './domain';
import { computerViewId, computerViews, type Fleet, type Installation } from './fleet';

export const locationKey = (location: ChatLocation) =>
  `${location.computerId}/${locationExecutionId(location)}/${location.environmentId}/${location.path}`;
export const locationExecutionId = (location: ChatLocation) =>
  location.executionEnvironmentId ?? location.environmentId;
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function locationExecutionEnvironment(fleet: Fleet, location: ChatLocation) {
  const folder = fleet.environments.find(
    (e) => e.id === location.environmentId && e.computerId === location.computerId,
  );
  const execution = fleet.environments.find(
    (e) => e.id === locationExecutionId(location) && e.computerId === location.computerId,
  );
  return folder &&
    execution &&
    (folder.id === execution.id ||
      (execution.platform === 'windows' &&
        folder.platform === 'wsl' &&
        folder.discoveredOn === execution.id))
    ? execution
    : undefined;
}
export function computerFolderEnvironments(fleet: Fleet, computerId: string) {
  const computer = computerViews(fleet).find((c) => c.id === computerId);
  if (!computer) return [];
  return fleet.environments.filter((e) =>
    computer.environments.some(
      (execution) =>
        e.id === execution.id ||
        (execution.platform === 'windows' &&
          e.platform === 'wsl' &&
          e.discoveredOn === execution.id &&
          e.computerId === execution.computerId),
    ),
  );
}
// Account connections belong to the selected execution computer, independently of the folder.
export function ensureLocationConnections(fleet: Fleet, location: ChatLocation) {
  const environment = locationExecutionEnvironment(fleet, location);
  if (!environment) throw new Error('This folder or execution computer is no longer available.');
  ensureEnvironmentConnections(fleet, environment.id, providerIds);
}
export function ensureEnvironmentConnections(
  fleet: Fleet,
  environmentId: string,
  detectedProviders: readonly ProviderId[],
) {
  const environment = fleet.environments.find((e) => e.id === environmentId);
  if (!environment) return;
  for (const provider of detectedProviders) {
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
  const environment = locationExecutionEnvironment(fleet, location);
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
  const view = computerViews(workspace.fleet).find((c) => c.id === computerId);
  const values = [
    ...(workspace.preferences.recentLocations ?? []),
    ...workspace.conversations.flatMap((c) => (c.location?.path ? [c.location] : [])),
  ];
  return [
    ...new Map(
      values
        .filter(
          (l) =>
            view?.environments.some(
              (e) => e.id === locationExecutionId(l) && e.computerId === l.computerId,
            ) && locationConnections(workspace.fleet, l).length,
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
      const environment = fleet.environments.find(
        (e) => e.id === location?.environmentId && e.computerId === location?.computerId,
      );
      const execution = location ? locationExecutionEnvironment(fleet, location) : undefined;
      const computerId = execution
        ? computerViewId(execution)
        : (location?.computerId ?? 'unassigned');
      if (!computers.has(computerId))
        computers.set(computerId, {
          id: computerId,
          name:
            computerViews(fleet).find((c) => c.id === computerId)?.name ?? 'Unavailable computer',
          folders: new Map(),
        });
      const computer = computers.get(computerId)!;
      const key = location ? locationKey(location) : 'unassigned';
      if (!computer.folders.has(key))
        computer.folders.set(key, {
          id: key,
          name: location?.path ? folderName(location.path) : 'Standalone',
          detail: `${environment?.name ?? 'Unavailable environment'} · ${location?.path || 'Standalone chats without a project folder'}`,
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
