import { expect, it } from 'vitest';
import { visualizationSchema, visualizationsSchema, visualizationDocument } from './visualizations';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { mergeShared, sharedWorkspace } from './sync';

const visual = {
  id: 'counter',
  title: 'Counter',
  revision: 1,
  source: '<button onclick="this.textContent=1">0</button>',
};
function reply(): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    createdAt: new Date().toISOString(),
    status: 'complete',
    runId: crypto.randomUUID(),
    blocks: [],
  };
}
it('persists and merges multiple visuals and stale events through a relay checkpoint without replaying tool activity', () => {
  const message = reply();
  const events: RunEvent[] = [];
  for (const visualization of [
    visual,
    { ...visual, id: 'second' },
    { ...visual, revision: 2, source: '<svg></svg>' },
    visual,
  ]) {
    const event: RunEvent = { kind: 'visualization', visualization };
    applyRunEvent(message, event);
    retainRunEvent(events, event);
  }
  expect(message.visualizations).toHaveLength(2);
  expect(events).toHaveLength(2);
  expect(events[0].visualization?.revision).toBe(2);
  expect(message.blocks).toEqual([]);
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Visual',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  });
  expect(
    restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0].messages[0]
      .visualizations,
  ).toEqual(message.visualizations);
  expect(historyFor(workspace.conversations[0])[0].visualizations).toEqual(message.visualizations);
  const base = sharedWorkspace(workspace),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.conversations[0].messages[0].visualizations = [{ ...visual, revision: 3 }];
  remote.conversations[0].messages[0].visualizations = [{ ...visual, id: 'second', revision: 2 }];
  const merged = mergeShared(base, local, remote);
  expect(merged.conversations).toHaveLength(1);
  expect(merged.conversations[0].messages[0].visualizations?.map((v) => v.revision)).toEqual([
    3, 2,
  ]);
});
it('rejects paths, duplicates, oversized UTF-8 sources and user-message events', () => {
  expect(visualizationSchema.safeParse({ ...visual, source: 'é'.repeat(256_001) }).success).toBe(
    false,
  );
  expect(
    visualizationSchema.safeParse({ ...visual, source: undefined, path: '/secret.html' }).success,
  ).toBe(false);
  expect(visualizationsSchema.safeParse([visual, visual]).success).toBe(false);
  expect(
    visualizationsSchema.safeParse(
      Array.from({ length: 5 }, (_, i) => ({
        ...visual,
        id: `v${i}`,
        source: 'x'.repeat(500_000),
      })),
    ).success,
  ).toBe(false);
  const message = reply();
  message.role = 'user';
  applyRunEvent(message, { kind: 'visualization', visualization: visual });
  expect(message.visualizations).toBeUndefined();
  expect(visualizationDocument(visual.source)).toContain(visual.source);
  expect(new TextEncoder().encode(visualizationDocument('x'.repeat(512_000))).length).toBeLessThan(
    520_000,
  );
});
