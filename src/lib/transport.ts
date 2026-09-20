import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import { createDesktopNotificationTracker } from './desktop-notifications';
import { applyAppBadge, pendingChatCount } from './notifications';
import { fallbackModels, type ModelCatalog } from './models';
import type { UsageSnapshot } from './usage';
import { retainRunEvent } from './activity';
import { answerSchema, type QuestionAnswer } from './questions';
import { elicitationInputSchema, type ElicitationInput } from './elicitations';
import { steeringInputSchema, type SteeringInput } from './steering';
import { runTimeoutMs } from './workflows';
import { createContextCache, type ContextSnapshot, type NativeInstructions } from './context';
import { mcpActionSchema, type McpAction, type McpResult } from './mcp';
import {
  browserScopeKey,
  browserSessionSignal,
  browserWorkspaceFromServer,
  clearBrowserWorkspace,
  discardOtherBrowserWorkspaces,
  readBrowserWorkspace,
  type BrowserWorkspaceScope,
} from './browser-workspace';
import { executionHost, type Installation, type WslDiscovery, type CliInstallation } from './fleet';
import {
  emptyShared,
  mergeShared,
  sharedSchema,
  sharedWorkspace,
  type SharedWorkspace,
  type Presence,
  type RelayJob,
} from './sync';
import {
  initialWorkspace,
  providerIds,
  restoreWorkspace,
  type ProviderStatus,
  type ProviderId,
  type RunEvent,
  type RunRequest,
  type Workspace,
  type ChatSettings,
  type ChatLocation,
} from './domain';

export const desktop = () => isTauri();

export async function desktopInstallerAvailable(): Promise<boolean> {
  const response = await fetch('/downloads/manifest.json', {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Unable to check desktop downloads.');
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('windows' in value) ||
    typeof value.windows !== 'boolean'
  )
    throw new Error('Unable to check desktop downloads.');
  return value.windows;
}
export { BrowserWorkspaceStorageError } from './browser-workspace';

export type DesktopNotificationSettings = {
  enabled: boolean;
  sound: boolean;
  lastError?: string;
  lastSent?: number;
};
export const desktopNotificationSettings = (): Promise<DesktopNotificationSettings> =>
  invoke('desktop_notification_settings');
export const setDesktopNotifications = (
  enabled: boolean,
  sound: boolean,
): Promise<DesktopNotificationSettings> => invoke('set_desktop_notifications', { enabled, sound });
export const testDesktopNotification = (): Promise<void> =>
  invoke('desktop_notification', { notice: { kind: 'test', tag: `test:${crypto.randomUUID()}` } });
export async function watchDesktopNotifications(
  open: (conversationId: string) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  return listen<string>('studio-notification-open', ({ payload }) => open(payload));
}
const desktopNotices = createDesktopNotificationTracker();
let notificationConversationId: () => string | undefined = () => undefined;
let notificationViewId = '';
let notificationViewRevision = 0;
function foregroundConversation(): string | undefined {
  return typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
    ? notificationConversationId()
    : undefined;
}
// A short, transient lease lets the relay suppress a push before it reaches a
// userVisibleOnly service worker. Each tab has its own revisioned identity.
export async function publishNotificationView(hidden = false): Promise<void> {
  if (!relayConnected) return;
  const conversationId = hidden ? null : (foregroundConversation() ?? null);
  notificationViewId ||= crypto.randomUUID();
  try {
    await relayApi('POST', 'v1/notification-view', {
      viewId: notificationViewId,
      revision: ++notificationViewRevision,
      conversationId,
    });
  } catch {
    // Older/offline relays keep delivering normally; never block chat or saving.
  }
}
export function watchNotificationView(current: () => string | undefined): () => void {
  notificationConversationId = current;
  const refresh = () => {
    void publishNotificationView();
  };
  const hide = () => {
    void publishNotificationView(true);
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('blur', hide);
  window.addEventListener('pagehide', hide);
  document.addEventListener('visibilitychange', refresh);
  const heartbeat = setInterval(refresh, 5000);
  const stopRelay = watchRelayConnection((ready) => {
    if (ready) refresh();
  });
  return () => {
    notificationConversationId = () => undefined;
    hide();
    stopRelay();
    clearInterval(heartbeat);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('blur', hide);
    window.removeEventListener('pagehide', hide);
    document.removeEventListener('visibilitychange', refresh);
  };
}
let badgeQueue = Promise.resolve();
let lastBadgeCount: number | undefined;
function updatePendingBadge(count: number) {
  // Serialize writes so an older count cannot land after a newer checkpoint.
  badgeQueue = badgeQueue
    .catch(() => {})
    .then(async () => {
      // A background service worker can also change a PWA's badge. Reapply the
      // current workspace count when it syncs, even if this page's value is unchanged.
      if (desktop() && lastBadgeCount === count) return;
      if (desktop()) await invoke('set_pending_chat_badge', { count });
      else await applyAppBadge(navigator, count);
      lastBadgeCount = count;
    });
  // Badge failures are independent of workspace persistence and agent execution.
  void badgeQueue.catch(() => {});
}

export async function artifactPreviewUrl(): Promise<string> {
  if (!desktop()) return '/artifact-preview';
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return convertFileSrc('', 'studio-artifact');
}

export async function downloadArtifact(source: string, filename: string, language: 'html' | 'svg') {
  if (desktop()) return await invoke<string>('save_artifact', { source, filename, language });
  const url = URL.createObjectURL(
    new Blob([source], { type: language === 'svg' ? 'image/svg+xml' : 'text/html' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export async function controlWindow(action: WindowAction): Promise<void> {
  if (!desktop()) return;
  await getCurrentWindow()[action]();
}

export async function watchWindowMaximized(
  onChange: (maximized: boolean) => void,
  onError: (error: unknown) => void,
): Promise<() => void> {
  if (!desktop()) return () => {};
  const appWindow = getCurrentWindow();
  let disposed = false;
  let revision = 0;
  const refresh = async () => {
    const current = ++revision;
    try {
      const maximized = await appWindow.isMaximized();
      if (!disposed && current === revision) onChange(maximized);
    } catch (error) {
      if (!disposed && current === revision) onError(error);
    }
  };
  const unlisten = await appWindow.onResized(refresh);
  await refresh();
  return () => {
    disposed = true;
    unlisten();
  };
}

type RuntimeContext = {
  installation: Installation;
  workspace: () => Workspace;
  statuses: () => Record<string, ProviderStatus>;
  localRuns: () => string[];
  apply: (value: SharedWorkspace) => Promise<void>;
  replaceBrowserWorkspace?: (
    value: Workspace,
    reason?: string,
    preserveInitialNotification?: boolean,
  ) => Promise<void>;
  checkpointRun: (
    request: RunRequest,
    event?: RunEvent,
    status?: 'complete' | 'cancelled' | 'error',
    error?: string,
  ) => Promise<void>;
};
let runtime: RuntimeContext | undefined;
let relayUrl = '';
let relayInstance = '';
let baseline = emptyShared();
let relayBusy = false;
let relayConnected = false;
let relayGeneration = 0;
let browserSessionCheckedAt = 0;
let browserWorkspaceId = '';
let browserScope: BrowserWorkspaceScope | undefined;
let browserSessionBlocked = false;
const relayConnectionListeners = new Set<(ready: boolean) => void>();
const remoteRuns = new Set<string>();
const workerRuns = new Map<string, RelayJob>();
export function configureRuntime(context: RuntimeContext) {
  runtime = context;
}
export const workspaceStorageScope = () =>
  desktop() ? 'desktop' : browserScope ? browserScopeKey(browserScope) : null;
export const relayConnectionGeneration = () => (relayConnected ? relayGeneration : null);
export function watchRelayConnection(listener: (ready: boolean) => void): () => void {
  relayConnectionListeners.add(listener);
  return () => {
    relayConnectionListeners.delete(listener);
  };
}
function notifyRelayConnection(ready: boolean) {
  for (const listener of relayConnectionListeners) listener(ready);
}

function announceBrowserSession(workspaceId: string) {
  localStorage.setItem(
    browserSessionSignal,
    JSON.stringify({ workspaceId, nonce: crypto.randomUUID() }),
  );
}
async function endBrowserSession(reason: string) {
  ++relayGeneration;
  relayConnected = false;
  browserSessionBlocked = true;
  browserWorkspaceId = '';
  const previousScope = browserScope;
  browserScope = undefined;
  notifyRelayConnection(false);
  baseline = emptyShared();
  contextCache = createContextCache(readContext);
  updatePendingBadge(0);
  await runtime?.replaceBrowserWorkspace?.(initialWorkspace(), reason);
  if (previousScope) clearBrowserWorkspace(localStorage, previousScope);
}
export function watchBrowserSession(): () => void {
  if (desktop()) return () => {};
  const changed = (event: StorageEvent) => {
    if (event.key !== browserSessionSignal) return;
    let workspaceId: unknown;
    try {
      workspaceId = JSON.parse(event.newValue ?? 'null')?.workspaceId;
    } catch {
      /* clear safely */
    }
    if (workspaceId === browserWorkspaceId) return;
    void endBrowserSession(
      'This browser’s workspace changed in another tab. Reload or pair again to continue.',
    );
  };
  window.addEventListener('storage', changed);
  return () => window.removeEventListener('storage', changed);
}
export async function getInstallation(): Promise<Installation> {
  if (desktop()) return invoke('get_installation');
  const stored = localStorage.getItem('agent-studio.installation');
  if (stored) return JSON.parse(stored);
  const installation: Installation = {
    id: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    name: 'This browser',
    platform: 'preview',
  };
  localStorage.setItem('agent-studio.installation', JSON.stringify(installation));
  return installation;
}
export async function detectConnection(
  provider: ProviderId,
  connectionId: string,
): Promise<ProviderStatus> {
  return invoke('detect_connection', { provider, connectionId });
}
export async function discoverWsl(): Promise<WslDiscovery> {
  return desktop() ? invoke('discover_wsl') : { distributions: [], warning: null };
}
export async function inspectEnvironmentClis(environmentId: string): Promise<CliInstallation[]> {
  return invoke('inspect_environment_clis', { environmentId });
}
function remoteTarget(connectionId?: string, environmentId?: string) {
  if (environmentId) {
    const fleet = runtime?.workspace().fleet;
    if (!fleet?.environments.some((e) => e.id === environmentId))
      throw new Error('This environment no longer exists.');
    const host = executionHost(fleet, environmentId);
    return host === runtime?.installation.id ? undefined : host;
  }
  if (!connectionId) return undefined;
  const connection = runtime?.workspace().fleet.connections.find((c) => c.id === connectionId);
  if (!connection)
    throw new Error('This connection no longer exists. Choose an account in Connections.');
  const host = executionHost(runtime!.workspace().fleet, connection.environmentId);
  return host === runtime?.installation.id ? undefined : host;
}
async function relayRaw(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  if (desktop()) return invoke('relay_request', { method, path, body: body ?? null });
  if (!runtime) throw new Error('This device is still loading.');
  const generation = relayGeneration;
  const sessionRequest = path === 'v1/browser-session';
  if (!sessionRequest && !browserWorkspaceId)
    throw new Error('Pair this device with your private workspace first.');
  const response = await fetch(`/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Environment-Id': runtime.installation.id,
      ...(browserWorkspaceId && !(sessionRequest && method === 'POST')
        ? { 'X-Workspace-Id': browserWorkspaceId }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    keepalive: path === 'v1/notification-view',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const result = {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : { error: 'Open the PWA on your Agent Studio server.' },
  };
  if (generation !== relayGeneration)
    throw new Error('The private workspace connection changed. Try again after pairing.');
  if (
    (result.status === 401 && !(sessionRequest && method === 'POST')) ||
    result.body?.code === 'workspace_changed'
  ) {
    const reason =
      result.body?.code === 'workspace_changed'
        ? 'This browser is paired with a different private workspace. Reload or pair again to continue.'
        : sessionRequest && method === 'GET' && !browserWorkspaceId
          ? ''
          : 'Your workspace session ended. Sign in again to continue.';
    await endBrowserSession(reason);
  }
  return result;
}
export class OfflineHostError extends Error {}
export type PushStatus = {
  publicKey: string;
  enabled: boolean;
  unavailable: boolean;
  deliveryFailed: boolean;
  lastSent?: number;
};
export async function pushSettings(): Promise<PushStatus> {
  return relayApi('GET', 'v1/push');
}
export async function savePushSubscription(subscription: PushSubscription): Promise<PushStatus> {
  return relayApi('PUT', 'v1/push', subscription.toJSON());
}
export async function disablePushNotifications(): Promise<void> {
  await relayApi('DELETE', 'v1/push');
}
export async function testPushNotification(): Promise<void> {
  await relayApi('POST', 'v1/push/test');
}

export type WorkspaceRole = 'admin' | 'member';
export type ManagedWorkspace = {
  id: string;
  name: string;
  role: WorkspaceRole;
  enabled: boolean;
  createdAt: number | null;
};
export type WorkspaceAdministration = {
  workspaceId: string;
  role: WorkspaceRole;
  workspaces?: ManagedWorkspace[];
};
export class WorkspaceAdministrationError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'WorkspaceAdministrationError';
  }
}
async function workspaceAdministrationRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  const generation = relayGeneration;
  if (!relayConnected)
    throw new WorkspaceAdministrationError('Connect to your workspace first.', 401);
  const response = await relayRaw(method, path, body);
  // Native requests also need a generation check: an old response must never
  // reveal an issued key after the renderer has changed relay connections.
  if (generation !== relayGeneration || !relayConnected)
    throw new WorkspaceAdministrationError('The private workspace connection changed.', 401);
  if (method === 'GET' && response.status === 404) return null;
  if (response.status >= 300)
    throw new WorkspaceAdministrationError(
      response.body?.error ?? 'Workspace administration failed.',
      response.status,
      response.body?.code,
    );
  return response.body as T;
}
export const readWorkspaceAdministration = () =>
  workspaceAdministrationRequest<WorkspaceAdministration>('GET', 'v1/workspace-admin');
export const createManagedWorkspace = (name: string, role: WorkspaceRole) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace; token: string }>(
    'POST',
    'v1/workspace-admin/workspaces',
    { name, role },
  );
export const updateManagedWorkspace = (id: string, name: string, role: WorkspaceRole) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace }>(
    'PUT',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}`,
    { name, role },
  );
export const rotateManagedWorkspaceKey = (id: string) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace; token: string }>(
    'POST',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}/rotate`,
  );
export const disableManagedWorkspace = (id: string) =>
  workspaceAdministrationRequest<{ workspace: ManagedWorkspace }>(
    'POST',
    `v1/workspace-admin/workspaces/${encodeURIComponent(id)}/disable`,
  );

async function relayApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await relayRaw(method, path, body);
  if (response.body?.code === 'host_offline') throw new OfflineHostError(response.body.error);
  if (response.status >= 300)
    throw new Error(response.body?.error ?? `Relay request failed (${response.status}).`);
  return response.body;
}
export async function connectRelay(url: string, token: string) {
  if (!runtime) throw new Error('This device is still loading.');
  if (workerRuns.size || remoteRuns.size)
    throw new Error('Wait for remote requests to finish before changing relays.');
  let generation = ++relayGeneration;
  notifyRelayConnection(false);
  if (desktop()) await invoke('relay_connect', { url, token });
  else {
    if (url !== window.location.origin)
      throw new Error('Open the PWA on your relay server to pair this device.');
    await endBrowserSession('');
    generation = relayGeneration;
    const session = await relayApi<{ workspaceId: string }>('POST', 'v1/browser-session', {
      token,
      environmentId: runtime.installation.id,
    });
    if (!session.workspaceId) throw new Error('Update the relay to support private workspaces.');
    browserSessionBlocked = false;
    browserWorkspaceId = session.workspaceId;
    browserSessionCheckedAt = Date.now();
    announceBrowserSession(session.workspaceId);
  }
  if (!(await acceptRelay(url, generation)))
    throw new Error('The private workspace connection changed. Pair this device again.');
}
async function acceptRelay(url: string, generation: number, restoring = false) {
  const state = await relayApi<{
    instanceId: string;
    workspaceId?: string;
    workspace: SharedWorkspace;
  }>('GET', 'v1/state');
  if (!state.instanceId) throw new Error('Relay protocol version is not supported.');
  if (!desktop()) {
    if (generation !== relayGeneration) return false;
    if (state.workspaceId !== browserWorkspaceId)
      throw new Error('The relay returned a different private workspace.');
    const preserveInitialNotification = restoring && !browserScope;
    const scope = { url, workspaceId: browserWorkspaceId, instanceId: state.instanceId };
    const saved = readBrowserWorkspace(localStorage, scope);
    discardOtherBrowserWorkspaces(localStorage, scope);
    const remote = sharedSchema.parse(state.workspace);
    if (!saved) {
      // Write the authenticated baseline first. If the page closes before its first
      // poll, a saved snapshot can still be merged against a verified checkpoint.
      localStorage.setItem(
        `${browserScopeKey(scope)}:sync`,
        JSON.stringify({
          url,
          instanceId: state.instanceId,
          base: remote,
        }),
      );
    }
    browserScope = scope;
    baseline = saved?.base ?? remote;
    relayInstance = state.instanceId;
    relayUrl = url;
    relayConnected = true;
    const restored = saved?.workspace ?? browserWorkspaceFromServer(remote);
    await runtime?.replaceBrowserWorkspace?.(restored, undefined, preserveInitialNotification);
    if (generation === relayGeneration) notifyRelayConnection(true);
    return generation === relayGeneration;
  }
  const checkpoint = await invoke<{
    url: string;
    instanceId: string;
    base: SharedWorkspace;
  } | null>('load_sync_state');
  if (generation !== relayGeneration) return false;
  if (restoring && checkpoint?.url === url && checkpoint.instanceId !== state.instanceId)
    throw new Error(
      'Relay data was replaced. Restore the original relay data, or use a separate installation for a new private workspace.',
    );
  const nextBaseline =
    checkpoint?.url === url && checkpoint.instanceId === state.instanceId
      ? sharedSchema.parse(checkpoint.base)
      : emptyShared();
  if (generation !== relayGeneration) return false;
  baseline = nextBaseline;
  relayInstance = state.instanceId;
  relayUrl = url;
  relayConnected = true;
  notifyRelayConnection(true);
  return true;
}
export async function resumeRelay(): Promise<boolean> {
  if (!desktop()) return resumeBrowserRelay();
  if (!runtime) return false;
  const generation = relayGeneration;
  // Native returns only the origin. Saved pairing keys never enter the renderer.
  const url = await invoke<string | null>('relay_resume');
  if (!url || generation !== relayGeneration) return false;
  return relayConnected || acceptRelay(url.replace(/\/$/, ''), generation, true);
}
export async function resumeBrowserRelay(): Promise<boolean> {
  if (desktop() || !runtime || browserSessionBlocked) return false;
  const generation = relayGeneration;
  const response = await relayRaw('GET', 'v1/browser-session');
  if (response.status === 401 || response.status === 404) return false;
  if (response.status !== 200) throw new Error('Server unavailable. Reconnecting automatically…');
  if (response.body.environmentId !== runtime.installation.id)
    throw new Error('Pair this device again to restore its server connection.');
  if (generation !== relayGeneration) return false;
  if (!response.body.workspaceId)
    throw new Error('Update the relay to support private workspaces.');
  if (browserWorkspaceId && browserWorkspaceId !== response.body.workspaceId) {
    await endBrowserSession(
      'This browser is paired with a different private workspace. Reload or pair again to continue.',
    );
    return false;
  }
  browserWorkspaceId = response.body.workspaceId;
  browserSessionCheckedAt = Date.now();
  return relayConnected || acceptRelay(window.location.origin, generation, true);
}
export async function disconnectRelay() {
  if (workerRuns.size || remoteRuns.size)
    throw new Error('Stop remote responses and wait for requests to finish before disconnecting.');
  ++relayGeneration;
  notifyRelayConnection(false);
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  if (desktop()) await invoke('relay_disconnect');
  else {
    await relayApi('DELETE', 'v1/browser-session');
    announceBrowserSession('');
    await endBrowserSession('Disconnected from your private workspace.');
  }
  relayConnected = false;
}
export async function pollRelay(): Promise<Presence[] | null> {
  if (!relayConnected || !runtime || relayBusy) return null;
  const generation = relayGeneration;
  relayBusy = true;
  try {
    if (!desktop() && Date.now() - browserSessionCheckedAt >= 60_000) {
      if (!(await resumeBrowserRelay()))
        throw new Error('Pair this device again to restore its server connection.');
    }
    const start = sharedWorkspace(runtime.workspace());
    let remote = await relayApi<{
      instanceId: string;
      revision: number;
      workspace: SharedWorkspace;
    }>('GET', 'v1/state');
    if (remote.instanceId !== relayInstance)
      throw new Error(
        'Relay data was replaced. Restore the original relay data, or use a separate installation for a new private workspace.',
      );
    // Verify the workspace first, then publish the viewed chat before a
    // completion checkpoint can enqueue push.
    await publishNotificationView();
    if (generation !== relayGeneration) return null;
    let accepted: SharedWorkspace | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const merged = mergeShared(baseline, start, sharedSchema.parse(remote.workspace));
      if (JSON.stringify(merged) === JSON.stringify(remote.workspace)) {
        accepted = merged;
        break;
      }
      const response = await relayRaw('PUT', 'v1/state', {
        revision: remote.revision,
        workspace: merged,
      });
      if (response.status === 409 && response.body?.code !== 'workspace_changed') {
        remote = response.body;
        continue;
      }
      if (response.status !== 200)
        throw new Error(response.body?.error ?? 'Workspace sync failed.');
      accepted = sharedSchema.parse(response.body.workspace);
      break;
    }
    if (!accepted) throw new Error('Workspace is changing quickly. Sync will retry shortly.');
    if (generation !== relayGeneration) return null;
    const current = sharedWorkspace(runtime.workspace());
    const combined = mergeShared(start, current, accepted);
    await runtime.apply(combined);
    if (generation !== relayGeneration) return null;
    // Save local data before advancing the merge checkpoint. Failed writes remain recoverable.
    const checkpoint = { url: relayUrl, instanceId: relayInstance, base: accepted };
    if (desktop()) await invoke('save_sync_state', { value: checkpoint });
    else if (browserScope)
      localStorage.setItem(`${browserScopeKey(browserScope)}:sync`, JSON.stringify(checkpoint));
    baseline = accepted;
    const connections = Object.entries(runtime.statuses()).map(([connectionId, s]) => ({
      connectionId,
      installed: s.installed,
      auth: s.auth,
      detail: s.detail,
      version: s.version,
    }));
    const presence = await relayApi<Presence[]>('POST', 'v1/heartbeat', {
      environmentId: runtime.installation.id,
      connections,
      running: desktop() ? [...runtime.localRuns(), ...workerRuns.keys()] : [],
    });
    const jobs = desktop() ? await relayApi<RelayJob[]>('GET', 'v1/jobs') : [];
    for (const job of jobs)
      if (!workerRuns.has(job.id)) {
        workerRuns.set(job.id, job);
        void executeJob(job);
      }
    return presence;
  } finally {
    relayBusy = false;
  }
}
export async function resolveRelaySettings(): Promise<string> {
  if (!runtime || !relayConnected) throw new Error('Connect to the relay first.');
  const generation = relayGeneration;
  const currentSession = () => {
    if (generation !== relayGeneration || !relayConnected)
      throw new Error('The private workspace connection changed. Try again after pairing.');
  };
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  currentSession();
  relayBusy = true;
  try {
    let backup: string;
    if (desktop())
      backup = await invoke<string>('export_workspace', { workspace: runtime.workspace() });
    else {
      if (!browserScope) throw new Error('Pair this device with your private workspace first.');
      localStorage.setItem(
        `${browserScopeKey(browserScope)}:backup`,
        JSON.stringify(runtime.workspace()),
      );
      backup = 'this browser’s local backup';
    }
    currentSession();
    const remote = await relayApi<{ workspace: SharedWorkspace }>('GET', 'v1/state');
    currentSession();
    await runtime.apply({
      ...sharedWorkspace(runtime.workspace()),
      fleet: sharedSchema.parse(remote.workspace).fleet,
    });
    return backup;
  } finally {
    relayBusy = false;
  }
}
async function localCall(
  method: RelayJob['method'],
  args: Record<string, unknown>,
  onEvent?: (event: RunEvent) => void,
): Promise<any> {
  if (!desktop())
    throw new Error('Choose a connected computer to run its agents from this device.');
  if (method === 'run') {
    const channel = new Channel<RunEvent>();
    channel.onmessage = onEvent ?? (() => {});
    return invoke('run_agent', { ...args, onEvent: channel });
  }
  const commands = {
    models: 'list_models',
    usage: 'read_usage',
    title: 'generate_title',
    folders: 'list_folders',
    context: 'read_context',
    mcp: 'manage_mcp',
    nativeInstructions: 'read_native_instructions',
    answer: 'answer_question',
    elicitation: 'manage_elicitation',
    steer: 'steer_run',
  };
  return invoke(commands[method], args);
}
async function routed<T>(
  method: RelayJob['method'],
  args: Record<string, unknown>,
  connectionId?: string,
  onEvent?: (event: RunEvent) => void,
  id: string = crypto.randomUUID(),
): Promise<T> {
  const target = remoteTarget(
    connectionId,
    method === 'folders' ? (args.environmentId as string) : undefined,
  );
  if (!target) return localCall(method, args, onEvent);
  if (!relayConnected || !runtime)
    throw new Error('Connect this environment to the relay to use a remote account.');
  const generation = relayGeneration;
  const currentSession = () => {
    if (generation !== relayGeneration || !relayConnected)
      throw new Error('The private workspace connection changed. This request was not replayed.');
  };
  remoteRuns.add(id);
  try {
    // Publish the conversation and its pinned connection before the target claims its work.
    if (
      method === 'run' ||
      method === 'folders' ||
      method === 'context' ||
      method === 'mcp' ||
      method === 'nativeInstructions'
    ) {
      while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
      await pollRelay();
    }
    currentSession();
    await relayApi('POST', 'v1/jobs', {
      id,
      source: runtime.installation.id,
      target,
      method,
      args,
    });
    const deadline =
      Date.now() +
      (method === 'folders'
        ? 30_000
        : runTimeoutMs(
            method === 'run' ? (args.request as RunRequest)?.agent?.provider : undefined,
          ) + 10_000);
    let previous: string[] = [];
    while (Date.now() < deadline) {
      currentSession();
      const job = await relayApi<RelayJob>('GET', `v1/jobs/${id}`);
      currentSession();
      job.events.forEach((event, index) => {
        const json = JSON.stringify(event);
        if (previous[index] !== json) onEvent?.(event as RunEvent);
        previous[index] = json;
      });
      if (job.status === 'error') throw new Error(job.error ?? 'Remote request failed.');
      if (job.status === 'cancelled') return 'cancelled' as T;
      if (job.status === 'complete') return job.result as T;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await relayApi('POST', `v1/jobs/${id}/cancel`).catch(() => {});
    throw new Error('Remote request timed out. Check the executing environment before retrying.');
  } finally {
    remoteRuns.delete(id);
  }
}
async function executeJob(job: RelayJob) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let publishing = Promise.resolve();
  let status: RelayJob['status'] = 'running';
  let result: unknown, error: string | undefined;
  const events: RunEvent[] = [];
  const request = job.method === 'run' ? (job.args.request as RunRequest) : undefined;
  let checkpoint = Promise.resolve();
  const persistEvent = (event?: RunEvent, finalStatus?: 'complete' | 'cancelled' | 'error') => {
    if (!request || !runtime) return;
    checkpoint = checkpoint
      .catch(() => {})
      .then(() => runtime!.checkpointRun(request, event, finalStatus, error));
  };
  const publish = () => {
    publishing = publishing
      .catch(() => {})
      .then(async () => {
        const response = await relayApi<RelayJob>('PUT', `v1/jobs/${job.id}`, {
          status,
          events,
          result,
          error,
        });
        if (response.cancel && status === 'running') {
          if (job.method === 'run')
            await invoke('cancel_run', { runId: (job.args.request as RunRequest)?.runId });
          if (job.method === 'title')
            await invoke('cancel_title', { conversationId: job.args.conversationId });
        }
      });
    return publishing;
  };
  try {
    const connectionId = job.args.connectionId;
    const connection = runtime
      ?.workspace()
      .fleet.connections.find(
        (c) =>
          c.id === connectionId &&
          executionHost(runtime!.workspace().fleet, c.environmentId) === runtime?.installation.id,
      );
    const folderEnvironment =
      job.method === 'folders' &&
      runtime
        ?.workspace()
        .fleet.environments.find(
          (e) =>
            e.id === job.args.environmentId &&
            executionHost(runtime!.workspace().fleet, e.id) === runtime?.installation.id,
        );
    if (
      job.method === 'folders'
        ? !folderEnvironment
        : !connection || typeof connectionId !== 'string'
    )
      throw new Error('Remote requests must select a connection owned by this environment.');
    if (job.method === 'run' && (job.args.request as RunRequest)?.runId !== job.id)
      throw new Error('Remote run identity mismatch.');
    timer = setInterval(() => {
      void publish().catch(() => {});
    }, 700);
    result = await localCall(job.method, job.args, (event) => {
      retainRunEvent(events, event);
      // The execution host retains results even if the initiating computer disconnects.
      persistEvent(event);
    });
    status = result === 'cancelled' ? 'cancelled' : 'complete';
  } catch (e) {
    status = 'error';
    error = String(e).slice(0, 4000);
  } finally {
    clearInterval(timer);
    persistEvent(
      undefined,
      status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'complete',
    );
    await checkpoint.catch(() => {});
    await publish().catch(() => {});
    workerRuns.delete(job.id);
  }
}
export async function readUsage(
  provider: ProviderId,
  model: string,
  force = false,
  connectionId?: string,
): Promise<UsageSnapshot> {
  return routed('usage', { provider, model, force, connectionId }, connectionId);
}
export async function readContext(
  settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'> & {
    conversationId?: string;
    forked?: boolean;
  },
  location?: ChatLocation,
): Promise<ContextSnapshot> {
  return routed(
    'context',
    {
      provider: settings.provider,
      model: settings.model,
      connectionId: settings.connectionId,
      location: location ?? null,
      conversationId: settings.conversationId ?? null,
      forked: settings.forked ?? false,
    },
    settings.connectionId,
  );
}
export let contextCache = createContextCache(readContext);
export async function manageMcp(
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
  conversationId: string | undefined,
  location: ChatLocation | undefined,
  action: McpAction,
): Promise<McpResult> {
  if (!settings.connectionId) throw new Error('Select an account connection first.');
  return routed(
    'mcp',
    {
      provider: settings.provider,
      connectionId: settings.connectionId,
      conversationId: conversationId ?? null,
      location: location ?? null,
      action: mcpActionSchema.parse(action),
    },
    settings.connectionId,
  );
}
export async function readNativeInstructions(
  conversationId: string,
  settings: Pick<ChatSettings, 'provider' | 'connectionId'>,
): Promise<NativeInstructions> {
  return routed(
    'nativeInstructions',
    {
      conversationId,
      provider: settings.provider,
      connectionId: settings.connectionId,
    },
    settings.connectionId,
  );
}
export type FolderListing = {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
};
export async function listFolders(environmentId: string, path = ''): Promise<FolderListing> {
  return routed('folders', { environmentId, path });
}
export async function generateTitle(
  conversationId: string,
  provider: ProviderId,
  firstMessage: string,
  connectionId?: string,
): Promise<{ title: string; provider: ProviderId; model: string }> {
  return routed(
    'title',
    {
      conversationId,
      provider,
      firstMessage: Array.from(firstMessage).slice(0, 2000).join(''),
      connectionId,
    },
    connectionId,
  );
}
export async function cancelTitle(conversationId: string) {
  if (desktop()) await invoke('cancel_title', { conversationId });
}
export async function loadModels(
  settings?: Pick<ChatSettings, 'provider' | 'connectionId'>,
): Promise<ModelCatalog> {
  return desktop() || (relayConnected && settings?.connectionId)
    ? routed(
        'models',
        { provider: settings?.provider, connectionId: settings?.connectionId },
        settings?.connectionId,
      )
    : structuredClone(fallbackModels);
}
export async function loadWorkspace(): Promise<Workspace> {
  const value = desktop() ? await invoke<unknown>('load_workspace') : null;
  return value ? restoreWorkspace(value) : initialWorkspace();
}
export async function saveWorkspace(
  workspace: Workspace,
  scope = workspaceStorageScope(),
): Promise<void> {
  if (desktop()) {
    await invoke('save_workspace', { workspace });
    for (const notice of desktopNotices(workspace)) {
      // Consume all lifecycle events, including suppressed ones, so switching
      // chats later cannot replay an alert the reader already saw.
      if (notice.conversationId === foregroundConversation()) continue;
      // Notification/audio failure must never fail saving or interrupt a CLI run.
      // Native delivery retains an actionable error in Connections.
      void invoke('desktop_notification', { notice }).catch(() => {});
    }
  } else {
    // A queued save from a former session must never be written to the new user's cache.
    if (!scope || scope !== workspaceStorageScope()) return;
    localStorage.setItem(scope, JSON.stringify(workspace));
  }
  updatePendingBadge(pendingChatCount(workspace.conversations));
}
export async function detectProviders(): Promise<ProviderStatus[]> {
  if (desktop()) return invoke('detect_providers');
  return providerIds.map((id) => ({
    id,
    installed: false,
    version: null,
    auth: 'unknown',
    detail: 'Open the desktop app to use installed CLIs.',
  }));
}
export async function runAgent(
  request: RunRequest,
  onEvent: (event: RunEvent) => void,
): Promise<'complete' | 'cancelled'> {
  return routed(
    'run',
    { request, connectionId: request.agent.connectionId },
    request.agent.connectionId,
    onEvent,
    request.runId,
  );
}
export async function cancelRun(runId: string, connectionId?: string, waitForCompletion = false) {
  if (remoteRuns.has(runId) || remoteTarget(connectionId)) {
    const generation = relayGeneration;
    const currentSession = () => {
      if (generation !== relayGeneration || !relayConnected)
        throw new Error('The private workspace connection changed. Cancellation was not replayed.');
    };
    currentSession();
    await relayApi('POST', `v1/jobs/${runId}/cancel`);
    currentSession();
    if (waitForCompletion) {
      const deadline = Date.now() + 20_000;
      while (true) {
        currentSession();
        const job = await relayApi<RelayJob>('GET', `v1/jobs/${runId}`);
        currentSession();
        if (['complete', 'cancelled', 'error'].includes(job.status)) break;
        if (Date.now() >= deadline)
          throw new Error(
            'The computer has not confirmed stopping the response. Try again when it is connected.',
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Merge the host's final checkpoint before publishing the deletion.
      while (relayBusy) {
        currentSession();
        if (Date.now() >= deadline) throw new Error('Sync is still busy. Try deleting again.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      currentSession();
      await pollRelay();
      currentSession();
    }
    return;
  }
  await invoke('cancel_run', { runId, waitForCompletion });
}
/**
 * Release the parked CLI process of a deleted conversation. Remote hosts keep no per-job
 * release route; their parked processes expire on the host's idle limit instead.
 */
export async function releaseConversation(conversationId: string, connectionId?: string) {
  if (!desktop() || remoteTarget(connectionId)) return;
  await invoke('release_conversation', { conversationId });
}
export async function answerQuestion(runId: string, answer: QuestionAnswer, connectionId?: string) {
  return routed<void>(
    'answer',
    { runId, answer: answerSchema.parse(answer), connectionId },
    connectionId,
  );
}
export async function manageElicitation(
  runId: string,
  input: ElicitationInput,
  connectionId?: string,
): Promise<unknown> {
  return routed(
    'elicitation',
    { runId, input: elicitationInputSchema.parse(input), connectionId },
    connectionId,
  );
}
export async function steerRun(runId: string, input: SteeringInput, connectionId?: string) {
  return routed<void>(
    'steer',
    { runId, input: steeringInputSchema.parse(input), connectionId },
    connectionId,
  );
}
export async function signIn(provider: string, connectionId?: string) {
  if (remoteTarget(connectionId))
    throw new Error(
      'Open sign-in on the computer that owns this connection. Authentication stays on that environment.',
    );
  await invoke('sign_in', { provider, connectionId });
}
export async function openLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (desktop()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener,noreferrer');
}
