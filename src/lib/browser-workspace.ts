import { initialWorkspace, restoreWorkspace, type Workspace } from './domain';
import { sharedSchema, type SharedWorkspace } from './sync';

export type BrowserWorkspaceScope = {
  url: string;
  workspaceId: string;
  instanceId: string;
};
export class BrowserWorkspaceStorageError extends Error {
  constructor() {
    super(
      'This browser’s saved private workspace could not be read. No saved data has been overwritten. Pair another browser to access the server copy, and recover this browser’s local data before clearing its storage.',
    );
    this.name = 'BrowserWorkspaceStorageError';
  }
}
export const browserSessionSignal = 'agent-studio.browser-session-change';
export const browserScopeKey = (scope: BrowserWorkspaceScope) =>
  `agent-studio.private-workspace.v1:${encodeURIComponent(JSON.stringify([scope.url, scope.workspaceId, scope.instanceId]))}`;

export function clearBrowserWorkspace(storage: Storage, scope: BrowserWorkspaceScope) {
  const key = browserScopeKey(scope);
  for (const suffix of ['', ':sync', ':backup', ':drafts']) storage.removeItem(`${key}${suffix}`);
}

export function discardOtherBrowserWorkspaces(storage: Storage, scope: BrowserWorkspaceScope) {
  const keep = browserScopeKey(scope);
  const remove: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (
      key?.startsWith('agent-studio.private-workspace.v1:') &&
      key !== keep &&
      !key.startsWith(`${keep}:`)
    )
      remove.push(key);
  }
  for (const key of remove) storage.removeItem(key);
  // Legacy data can only migrate above after matching the authenticated owner.
  // Once another identity is accepted, do not leave unscoped chat copies behind.
  for (const key of [
    'agent-studio.browser.v1',
    'agent-studio.browser-sync',
    'agent-studio.browser-backup',
    'agent-studio.preview.v1',
  ])
    storage.removeItem(key);
}

// A saved browser snapshot is never an authentication source. Call only after the
// server has confirmed both the session's workspace and that workspace's instance.
export function readBrowserWorkspace(storage: Storage, scope: BrowserWorkspaceScope) {
  const key = browserScopeKey(scope);
  let saved = storage.getItem(key);
  let checkpoint = storage.getItem(`${key}:sync`);
  if (!saved && !checkpoint && scope.workspaceId === 'owner') {
    const legacy = storage.getItem('agent-studio.browser-sync');
    if (legacy) {
      try {
        const previous = JSON.parse(legacy);
        if (previous.url === scope.url && previous.instanceId === scope.instanceId) {
          saved = storage.getItem('agent-studio.browser.v1');
          checkpoint = legacy;
          if (saved) {
            // Validate before removing the old, unscoped copy.
            restoreWorkspace(JSON.parse(saved));
            sharedSchema.parse(previous.base);
            storage.setItem(key, saved);
            storage.setItem(`${key}:sync`, legacy);
            storage.removeItem('agent-studio.browser.v1');
            storage.removeItem('agent-studio.browser-sync');
            storage.removeItem('agent-studio.browser-backup');
          }
        }
      } catch {
        // Untrusted or damaged legacy data must not replace the server workspace.
        saved = checkpoint = null;
      }
    }
  }
  if (!saved && !checkpoint) return undefined;
  if (!checkpoint) throw new BrowserWorkspaceStorageError();
  try {
    const previous = JSON.parse(checkpoint);
    if (previous.url !== scope.url || previous.instanceId !== scope.instanceId)
      throw new BrowserWorkspaceStorageError();
    const base = sharedSchema.parse(previous.base);
    if (!saved) return undefined;
    return {
      workspace: restoreWorkspace(JSON.parse(saved)),
      base,
    };
  } catch {
    throw new BrowserWorkspaceStorageError();
  }
}

export function browserWorkspaceFromServer(shared: SharedWorkspace): Workspace {
  return { ...initialWorkspace(), ...shared };
}
