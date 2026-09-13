import type { ChatLocation, ChatSettings, ProviderId } from './domain';

export type ContextKind = 'instructions' | 'skills' | 'memories' | 'mcps';
export type ContextEntry = {
  name: string;
  path: string;
  kind: ContextKind;
  scope: string;
  status:
    | 'discovered'
    | 'reported'
    | 'disabled'
    | 'shadowed'
    | 'reference'
    | 'configured'
    | 'connected'
    | 'failed'
    | 'pending'
    | 'needsAuth'
    | 'unknown';
  detail: string;
};
export type ContextSnapshot = {
  provider: ProviderId;
  model: string;
  checkedAt: number;
  execution: string;
  folder: string;
  profile: string;
  entries: ContextEntry[];
  notes: string[];
  truncated: boolean;
  commands?: { name: string; description: string; argumentHint: string }[];
};

// Deliberately kept out of the shared source/skill catalog cache and workspace schema.
export type NativeInstructions = {
  provider: string;
  checkedAt: number;
  blocks: {
    label: string;
    text: string;
    capturedAt: string | null;
    version: string | null;
    model: string | null;
  }[];
  notice: string;
  studioGuidance: string;
};
export const contextStatuses: Record<ContextEntry['status'], string> = {
  discovered: 'Discovered',
  reported: 'Reported',
  disabled: 'Disabled',
  shadowed: 'Overridden',
  reference: 'Reference',
  configured: 'Configured',
  connected: 'Connected',
  failed: 'Failed',
  pending: 'Connecting',
  needsAuth: 'Sign-in required',
  unknown: 'Unknown',
};

export type ContextSelection = Pick<ChatSettings, 'provider' | 'model' | 'connectionId'>;
export function contextKey(settings: ContextSelection, location?: ChatLocation): string {
  return JSON.stringify([
    settings.provider,
    settings.model,
    settings.connectionId ?? null,
    location?.computerId ?? null,
    location?.environmentId ?? null,
    location?.executionEnvironmentId ?? location?.environmentId ?? null,
    location?.path ?? null,
  ]);
}

// Session-only metadata cache survives closing the inspector, without entering saved chats.
export function createContextCache(
  read: (settings: ContextSelection, location?: ChatLocation) => Promise<ContextSnapshot>,
) {
  const snapshots = new Map<string, ContextSnapshot>();
  const pending = new Map<string, Promise<ContextSnapshot>>();
  const remember = (key: string, value: ContextSnapshot) => {
    snapshots.delete(key);
    snapshots.set(key, value);
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
    return value;
  };
  return {
    peek(settings: ContextSelection, location?: ChatLocation): ContextSnapshot | undefined {
      const key = contextKey(settings, location);
      const value = snapshots.get(key);
      return value ? remember(key, value) : undefined;
    },
    refresh(settings: ContextSelection, location?: ChatLocation): Promise<ContextSnapshot> {
      const selected = { ...settings };
      const folder = location ? { ...location } : undefined;
      const key = contextKey(selected, folder);
      const existing = pending.get(key);
      if (existing) return existing;
      const request = Promise.resolve()
        .then(() => read(selected, folder))
        .then((value) => remember(key, value))
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    },
  };
}
