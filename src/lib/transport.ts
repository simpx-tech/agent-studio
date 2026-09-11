import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fallbackModels, type ModelCatalog } from './models';
import type { UsageSnapshot } from './usage';
import { retainRunEvent } from './activity';
import { runTimeoutMs } from './workflows';
import { createContextCache, type ContextSnapshot } from './context';
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
const remoteRuns = new Set<string>();
const workerRuns = new Map<string, RelayJob>();
export function configureRuntime(context: RuntimeContext) {
  runtime = context;
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
  const response = await fetch(`/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Environment-Id': runtime.installation.id },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : { error: 'Open the PWA on your Agent Studio server.' },
  };
}
export class OfflineHostError extends Error {}
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
  const generation = ++relayGeneration;
  if (desktop()) await invoke('relay_connect', { url, token });
  else {
    if (url !== window.location.origin)
      throw new Error('Open the PWA on your relay server to pair this device.');
    await relayApi('POST', 'v1/browser-session', { token, environmentId: runtime.installation.id });
  }
  await acceptRelay(url, generation);
}
async function acceptRelay(url: string, generation: number, restoring = false) {
  const state = await relayApi<{ instanceId: string }>('GET', 'v1/state');
  if (!state.instanceId) throw new Error('Relay protocol version is not supported.');
  const checkpoint = desktop()
    ? await invoke<{
        url: string;
        instanceId: string;
        base: SharedWorkspace;
      } | null>('load_sync_state')
    : JSON.parse(localStorage.getItem('agent-studio.browser-sync') ?? 'null');
  if (generation !== relayGeneration) return false;
  if (restoring && checkpoint?.url === url && checkpoint.instanceId !== state.instanceId)
    throw new Error(
      'Relay data was replaced. Disconnect and pair again to merge your local workspace safely.',
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
  if (desktop() || !runtime) return false;
  const generation = relayGeneration;
  const response = await relayRaw('GET', 'v1/browser-session');
  if (response.status === 401 || response.status === 404) return false;
  if (response.status !== 200) throw new Error('Server unavailable. Reconnecting automatically…');
  if (response.body.environmentId !== runtime.installation.id)
    throw new Error('Pair this device again to restore its server connection.');
  if (generation !== relayGeneration) return false;
  browserSessionCheckedAt = Date.now();
  return relayConnected || acceptRelay(window.location.origin, generation, true);
}
export async function disconnectRelay() {
  if (workerRuns.size || remoteRuns.size)
    throw new Error('Stop remote responses and wait for requests to finish before disconnecting.');
  ++relayGeneration;
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  if (desktop()) await invoke('relay_disconnect');
  else await relayApi('DELETE', 'v1/browser-session');
  relayConnected = false;
}
export async function pollRelay(): Promise<Presence[] | null> {
  if (!relayConnected || !runtime || relayBusy) return null;
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
        'Relay data was replaced. Disconnect and pair again to merge your local workspace safely.',
      );
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
      if (response.status === 409) {
        remote = response.body;
        continue;
      }
      if (response.status !== 200)
        throw new Error(response.body?.error ?? 'Workspace sync failed.');
      accepted = sharedSchema.parse(response.body.workspace);
      break;
    }
    if (!accepted) throw new Error('Workspace is changing quickly. Sync will retry shortly.');
    const current = sharedWorkspace(runtime.workspace());
    const combined = mergeShared(start, current, accepted);
    await runtime.apply(combined);
    // Save local data before advancing the merge checkpoint. Failed writes remain recoverable.
    const checkpoint = { url: relayUrl, instanceId: relayInstance, base: accepted };
    if (desktop()) await invoke('save_sync_state', { value: checkpoint });
    else localStorage.setItem('agent-studio.browser-sync', JSON.stringify(checkpoint));
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
  while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
  relayBusy = true;
  try {
    let backup: string;
    if (desktop())
      backup = await invoke<string>('export_workspace', { workspace: runtime.workspace() });
    else {
      localStorage.setItem('agent-studio.browser-backup', JSON.stringify(runtime.workspace()));
      backup = 'this browser’s local backup';
    }
    const remote = await relayApi<{ workspace: SharedWorkspace }>('GET', 'v1/state');
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
  remoteRuns.add(id);
  try {
    // Publish the conversation and its pinned connection before the target claims its work.
    if (method === 'run' || method === 'folders' || method === 'context') {
      while (relayBusy) await new Promise((resolve) => setTimeout(resolve, 100));
      await pollRelay();
    }
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
      const job = await relayApi<RelayJob>('GET', `v1/jobs/${id}`);
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
  settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'>,
  location?: ChatLocation,
): Promise<ContextSnapshot> {
  return routed(
    'context',
    {
      provider: settings.provider,
      model: settings.model,
      connectionId: settings.connectionId,
      location: location ?? null,
    },
    settings.connectionId,
  );
}
export const contextCache = createContextCache(readContext);
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
  const value = desktop()
    ? await invoke<unknown>('load_workspace')
    : JSON.parse(
        localStorage.getItem('agent-studio.browser.v1') ??
          localStorage.getItem('agent-studio.preview.v1') ??
          'null',
      );
  return value ? restoreWorkspace(value) : initialWorkspace();
}
export async function saveWorkspace(workspace: Workspace): Promise<void> {
  if (desktop()) await invoke('save_workspace', { workspace });
  else localStorage.setItem('agent-studio.browser.v1', JSON.stringify(workspace));
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
    await relayApi('POST', `v1/jobs/${runId}/cancel`);
    if (waitForCompletion) {
      const deadline = Date.now() + 20_000;
      while (true) {
        const job = await relayApi<RelayJob>('GET', `v1/jobs/${runId}`);
        if (['complete', 'cancelled', 'error'].includes(job.status)) break;
        if (Date.now() >= deadline)
          throw new Error(
            'The computer has not confirmed stopping the response. Try again when it is connected.',
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Merge the host's final checkpoint before publishing the deletion.
      while (relayBusy) {
        if (Date.now() >= deadline) throw new Error('Sync is still busy. Try deleting again.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await pollRelay();
    }
    return;
  }
  await invoke('cancel_run', { runId, waitForCompletion });
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
