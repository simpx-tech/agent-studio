import type { ChatLocation, ChatSettings, ProviderId } from './domain';

export type ContextKind = 'instructions' | 'skills' | 'memories' | 'mcps' | 'hooks';
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
    | 'needsReview'
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
  needsReview: 'Review required',
  unknown: 'Unknown',
};

export type ContextSelection = Pick<ChatSettings, 'provider' | 'model' | 'connectionId'> & {
  conversationId?: string;
  forked?: boolean;
};
export function contextKey(settings: ContextSelection, location?: ChatLocation): string {
  return JSON.stringify([
    settings.provider,
    settings.model,
    settings.connectionId ?? null,
    location?.computerId ?? null,
    location?.environmentId ?? null,
    location?.executionEnvironmentId ?? location?.environmentId ?? null,
    location?.path ?? null,
    settings.conversationId ?? null,
    !!settings.forked,
  ]);
}

// Session-only metadata cache survives closing the inspector, without entering saved chats.
export function createContextCache(
  read: (settings: ContextSelection, location?: ChatLocation) => Promise<ContextSnapshot>,
  scope: () => string = () => '',
) {
  const snapshots = new Map<string, ContextSnapshot>();
  const pending = new Map<string, Promise<ContextSnapshot>>();
  let generation = 0;
  const remember = (key: string, value: ContextSnapshot) => {
    snapshots.delete(key);
    snapshots.set(key, value);
    if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value!);
    return value;
  };
  return {
    clear() {
      generation++;
      snapshots.clear();
      pending.clear();
    },
    peek(settings: ContextSelection, location?: ChatLocation): ContextSnapshot | undefined {
      const key = contextKey(settings, location) + scope();
      const value = snapshots.get(key);
      return value ? remember(key, value) : undefined;
    },
    refresh(settings: ContextSelection, location?: ChatLocation): Promise<ContextSnapshot> {
      const selected = { ...settings };
      const folder = location ? { ...location } : undefined;
      const selectedScope = scope();
      const key = contextKey(selected, folder) + selectedScope;
      const existing = pending.get(key);
      if (existing) return existing;
      const started = generation;
      const request = Promise.resolve()
        .then(() => read(selected, folder))
        .then((value) => {
          if (scope() !== selectedScope)
            throw new Error('Shared context changed during inspection. Open Model context again.');
          return started === generation ? remember(key, value) : value;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
  };
}
