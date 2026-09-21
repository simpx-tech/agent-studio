import { z } from 'zod';

const id = z.string().uuid();
export const computerSchema = z.object({ id, name: z.string().trim().min(1).max(60) });
export const environmentSchema = z.object({
  id,
  computerId: id,
  name: z.string().trim().min(1).max(60),
  platform: z.enum(['windows', 'macos', 'linux', 'wsl', 'preview']),
  distribution: z.string().trim().min(1).max(255).optional(),
  // The Windows app executes this distribution's CLI connections through wsl.exe.
  discoveredOn: id.optional(),
});
export const accountSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  provider: z.enum(['codex', 'claude', 'gemini']),
  purpose: z.enum(['personal', 'work']),
});
export const connectionSchema = z.object({
  id,
  environmentId: id,
  accountId: id,
  profile: z.enum(['existing', 'isolated']),
  sharedContextConnectionId: id.optional(),
  // Separate profiles share this computer's CLI context unless set to 'none' or to an account.
  sharedContext: z.enum(['computer', 'none']).optional(),
  // A separate profile made from this computer's terminal login: the same account is signed in
  // there, so detection must not register that login again as another label.
  fromTerminalLogin: z.boolean().optional(),
});
export const fleetSchema = z.object({
  computers: z.array(computerSchema),
  environments: z.array(environmentSchema),
  accounts: z.array(accountSchema),
  connections: z.array(connectionSchema),
});
export type Fleet = z.infer<typeof fleetSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type Installation = {
  id: string;
  computerId: string;
  name: string;
  platform: Environment['platform'];
  distribution?: string;
};
export type WslDiscovery = {
  distributions: { id: string; name: string; running: boolean | null }[];
  warning: string | null;
};
export function executionHost(fleet: Fleet, environmentId: string): string {
  return fleet.environments.find((e) => e.id === environmentId)?.discoveredOn ?? environmentId;
}
// Presentation only: keep stored host/location identities and relay ownership intact.
export function computerViewId(environment: Environment) {
  return environment.platform === 'wsl' && environment.discoveredOn
    ? environment.id
    : environment.computerId;
}
export function computerViews(fleet: Fleet) {
  return fleet.computers.flatMap((computer) => {
    const environments = fleet.environments.filter((e) => e.computerId === computer.id);
    const native = environments.filter((e) => computerViewId(e) === computer.id);
    return [
      ...(native.length || !environments.length
        ? [{ ...computer, computerId: computer.id, environments: native, wsl: false, hostName: '' }]
        : []),
      ...environments
        .filter((e) => computerViewId(e) !== computer.id)
        .map((e) => ({
          id: e.id,
          computerId: computer.id,
          name: e.name,
          environments: [e],
          wsl: true,
          hostName: computer.name,
        })),
    ];
  });
}
export type CliInstallation = { id: 'codex' | 'claude' | 'gemini'; path: string | null };
export type CliInventory = { entries?: CliInstallation[]; error?: string; checking: boolean };
export const emptyFleet = (): Fleet => ({
  computers: [],
  environments: [],
  accounts: [],
  connections: [],
});
export function registerInstallation(fleet: Fleet, installation: Installation) {
  const existing = fleet.environments.find((e) => e.id === installation.id);
  if (existing) {
    if (installation.distribution) {
      existing.distribution = installation.distribution;
      if (existing.name === 'WSL')
        existing.name = `WSL · ${installation.distribution}`.slice(0, 60);
    }
    delete existing.discoveredOn;
    reconcileDiscoveredWsl(fleet);
    return;
  }
  if (!fleet.computers.some((c) => c.id === installation.computerId))
    fleet.computers.push({ id: installation.computerId, name: installation.name });
  fleet.environments.push({
    id: installation.id,
    computerId: installation.computerId,
    name:
      installation.platform === 'wsl'
        ? `WSL${installation.distribution ? ` · ${installation.distribution}` : ''}`.slice(0, 60)
        : installation.platform === 'windows'
          ? 'Windows'
          : installation.platform === 'macos'
            ? 'macOS'
            : installation.platform === 'preview'
              ? 'Browser preview'
              : 'Linux',
    platform: installation.platform,
    ...(installation.distribution ? { distribution: installation.distribution } : {}),
  });
}
export function reconcileDiscoveredWsl(fleet: Fleet) {
  fleet.environments = fleet.environments.filter(
    (candidate) =>
      !candidate.discoveredOn ||
      fleet.connections.some((c) => c.environmentId === candidate.id) ||
      !fleet.environments.some(
        (e) =>
          !e.discoveredOn &&
          e.platform === 'wsl' &&
          e.computerId === candidate.computerId &&
          e.distribution?.toLowerCase() === candidate.distribution?.toLowerCase(),
      ),
  );
}
export function registerWslEnvironments(
  fleet: Fleet,
  installation: Installation,
  discovery: WslDiscovery,
) {
  const host = fleet.environments.find((e) => e.id === installation.id);
  if (!host || installation.platform !== 'windows') return;
  // Keep discoveries with their Windows host when the user changes computer grouping.
  for (const e of fleet.environments)
    if (e.discoveredOn === host.id) e.computerId = host.computerId;
  reconcileDiscoveredWsl(fleet);
  for (const distro of discovery.distributions) {
    const existing = fleet.environments.filter(
      (e) =>
        e.id === distro.id ||
        (e.platform === 'wsl' &&
          e.computerId === host.computerId &&
          e.distribution?.toLowerCase() === distro.name.toLowerCase()),
    );
    if (existing.length) {
      for (const environment of existing) environment.discoveredOn = host.id;
      continue;
    }
    fleet.environments.push({
      id: distro.id,
      computerId: host.computerId,
      name: `WSL · ${distro.name}`.slice(0, 60),
      platform: 'wsl',
      distribution: distro.name,
      discoveredOn: host.id,
    });
  }
  reconcileDiscoveredWsl(fleet);
}
// Effective shared-context choice: an account connection id, 'computer', or '' for none.
// A terminal login is this computer's context by itself, so it reads as 'computer'.
export function sharedContextChoice(connection: Connection): string {
  if (connection.sharedContextConnectionId) return connection.sharedContextConnectionId;
  return connection.sharedContext === 'none' ? '' : 'computer';
}
// Choosing "This account only" on a terminal login turns that connection into a separate
// profile for the same account: its own directory, its own sign-in, and no shared context.
// The terminal keeps its login and files; existing chats continue through history transfer.
export function applySharedContextChoice(connection: Connection, choice: string) {
  delete connection.sharedContextConnectionId;
  delete connection.sharedContext;
  if (choice === 'computer') return;
  if (choice) {
    connection.sharedContextConnectionId = choice;
    return;
  }
  if (connection.profile === 'existing') {
    connection.profile = 'isolated';
    connection.fromTerminalLogin = true;
  }
  connection.sharedContext = 'none';
}
export function accountName(fleet: Fleet, connectionId?: string): string | undefined {
  const connection = fleet.connections.find((c) => c.id === connectionId);
  return fleet.accounts.find((a) => a.id === connection?.accountId)?.name;
}
export function connectionLabel(fleet: Fleet, connectionId?: string) {
  const connection = fleet.connections.find((c) => c.id === connectionId);
  const account = fleet.accounts.find((a) => a.id === connection?.accountId);
  const environment = fleet.environments.find((e) => e.id === connection?.environmentId);
  const computer = fleet.computers.find((c) => c.id === environment?.computerId);
  return connection
    ? `${account?.name ?? 'Removed account'} · ${computer?.name ?? 'Computer'} / ${environment?.name ?? 'Environment'}`
    : 'This environment · CLI login';
}
