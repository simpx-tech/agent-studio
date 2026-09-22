import { describe, expect, it } from 'vitest';
import {
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Conversation,
} from './domain';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';
import { registerInstallation } from './fleet';
import { snapshotFor, type UsageSnapshot } from './usage';

const chat = (): Conversation => ({
  id: crypto.randomUUID(),
  settings: settingsFor(initialWorkspace().preferences),
  title: 'Original',
  createdAt: '2026-09-08',
  updatedAt: '2026-09-08',
  messages: [],
});
describe('workspace replication', () => {
  it('migrates v2 and registers only this installation without inventing remote machines or accounts', () => {
    const old = {
      version: 2,
      preferences: initialWorkspace().preferences,
      conversations: [chat()],
    };
    const next = restoreWorkspace(old);
    expect(next.version).toBe(3);
    expect(next.conversations).toEqual(old.conversations);
    const installation = {
      id: crypto.randomUUID(),
      computerId: crypto.randomUUID(),
      name: 'Desktop',
      platform: 'windows' as const,
    };
    registerInstallation(next.fleet, installation);
    registerInstallation(next.fleet, installation);
    expect(next.fleet.environments).toHaveLength(1);
    expect(next.fleet.accounts).toEqual([]);
  });
  it('merges independent offline chats and propagates deletions without resurrection', () => {
    const base = emptyShared();
    base.conversations.push(chat());
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations = [chat()];
    remote.conversations.push(chat());
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations.map((c) => c.id)).toEqual([
      local.conversations[0].id,
      remote.conversations[1].id,
    ]);
    expect(mergeShared(merged, structuredClone(merged), merged)).toEqual(merged);
  });
  it('retains concurrent edits and edit-versus-delete as named conflict copies', () => {
    const base = emptyShared();
    base.conversations.push(chat());
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations[0].title = 'Local';
    remote.conversations[0].title = 'Remote';
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations.map((c) => c.title)).toEqual(['Remote', 'Local (conflict copy)']);
    expect(merged.conversations[0].id).toBe(base.conversations[0].id);
    expect(merged.conversations[1].id).not.toBe(base.conversations[0].id);
    remote.conversations = [];
    expect(mergeShared(base, local, remote).conversations[0].title).toBe('Local (conflict copy)');
  });
  it('deletion wins over late reply and generated-title checkpoints while deliberate edits survive', () => {
    const base = emptyShared();
    const conversation = { ...chat(), titleStatus: 'pending' as const };
    conversation.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Hello' }],
    });
    base.conversations.push(conversation);
    const deleted = structuredClone(base);
    deleted.conversations = [];
    const checkpoint = structuredClone(base);
    const completed = checkpoint.conversations[0];
    completed.messages[0].status = 'cancelled';
    completed.messages[0].blocks[0].text = 'Hello world';
    completed.messages[0].durationMs = 500;
    completed.title = 'Generated title';
    completed.titleStatus = 'generated';
    completed.titleSource = { provider: 'codex', model: 'fixture' };
    completed.updatedAt = '2026-09-11';
    for (const [local, remote] of [
      [deleted, checkpoint],
      [checkpoint, deleted],
    ]) {
      expect(mergeShared(base, local, remote).conversations).toEqual([]);
    }
    for (const edit of ['settings', 'title', 'message']) {
      const deliberate = structuredClone(checkpoint);
      const chat = deliberate.conversations[0];
      if (edit === 'settings') chat.settings.instructions = 'Keep this deliberate edit';
      if (edit === 'title') {
        chat.title = 'My title';
        chat.titleStatus = 'fallback';
      }
      if (edit === 'message')
        chat.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          createdAt: '',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'A new turn' }],
        });
      expect(mergeShared(base, deleted, deliberate).conversations).toHaveLength(1);
      expect(mergeShared(base, deliberate, deleted).conversations).toHaveLength(1);
    }
  });
  it('coalesces copies of the same live response and never downgrades completion', () => {
    const base = emptyShared();
    const c = chat();
    c.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: '' }],
    });
    base.conversations.push(c);
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.conversations[0].messages[0].blocks[0].text = 'Hello';
    remote.conversations[0].messages[0].blocks[0].text = 'Hello world';
    remote.conversations[0].messages[0].status = 'complete';
    const merged = mergeShared(base, local, remote);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.conversations[0].messages[0].status).toBe('complete');
    expect(merged.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    local.conversations[0].messages[0].durationMs = 1200;
    local.conversations[0].messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      createdAt: '',
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Next turn' }],
    });
    const continued = mergeShared(base, local, remote);
    expect(continued.conversations).toHaveLength(1);
    expect(continued.conversations[0].messages).toHaveLength(2);
    expect(continued.conversations[0].messages[0].durationMs).toBe(1200);
  });
  it('lets only the restarted execution host interrupt its dead run over a newer checkpoint', () => {
    const base = emptyShared();
    const c = chat();
    const runId = crypto.randomUUID();
    c.messages.push({
      id: crypto.randomUUID(),
      runId,
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [{ type: 'markdown', text: 'Hel' }],
    });
    base.conversations.push(c);
    const local = structuredClone(base),
      remote = structuredClone(base);
    // This device restarted: its saved copy was restored as interrupted.
    local.conversations[0].messages[0].status = 'cancelled';
    local.conversations[0].messages[0].error = interruptedReplyError;
    // The relay holds a later checkpoint of the same run.
    remote.conversations[0].messages[0].blocks[0].text = 'Hello world';
    const viewer = mergeShared(base, local, remote);
    expect(viewer.conversations[0].messages[0].status).toBe('running');
    expect(viewer.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    const live = mergeShared(base, local, remote, { deadRun: () => false });
    expect(live.conversations[0].messages[0].status).toBe('running');
    const seen: string[] = [];
    const host = mergeShared(base, local, remote, {
      deadRun: (conversation, message) => {
        seen.push(`${conversation.id}:${message.runId}`);
        return true;
      },
    });
    expect(seen).toEqual([`${c.id}:${runId}`]);
    expect(host.conversations[0].messages[0]).toMatchObject({
      status: 'cancelled',
      error: interruptedReplyError,
    });
    expect(host.conversations[0].messages[0].blocks[0].text).toBe('Hello world');
    remote.conversations[0].messages[0].status = 'complete';
    const finished = mergeShared(base, local, remote, { deadRun: () => true });
    expect(finished.conversations[0].messages[0].status).toBe('complete');
    expect(finished.conversations[0].messages[0].error).toBeUndefined();
  });
  it('preserves archive and restore changes alongside a concurrent response checkpoint', () => {
    for (const archived of [true, false]) {
      const base = emptyShared();
      const conversation = { ...chat(), archived: !archived };
      conversation.messages.push({
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        createdAt: '',
        status: 'running',
        blocks: [{ type: 'markdown', text: 'Hello' }],
      });
      base.conversations.push(conversation);
      const edited = structuredClone(base);
      edited.conversations[0].archived = archived;
      const checkpoint = structuredClone(base);
      checkpoint.conversations[0].messages[0].status = 'complete';
      checkpoint.conversations[0].messages[0].blocks[0].text = 'Hello world';
      for (const [local, remote] of [
        [edited, checkpoint],
        [checkpoint, edited],
      ]) {
        const merged = mergeShared(base, local, remote);
        expect(merged.conversations).toHaveLength(1);
        expect(merged.conversations[0].id).toBe(conversation.id);
        expect(merged.conversations[0].archived).toBe(archived);
        expect(merged.conversations[0].messages).toEqual(checkpoint.conversations[0].messages);
      }
      // Without a shared baseline, keep the two distinct edits for review.
      expect(mergeShared(emptyShared(), edited, checkpoint).conversations).toHaveLength(2);
    }
  });
  it('surfaces conflicting connection routing instead of silently choosing an account', () => {
    const base = emptyShared();
    base.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.fleet.computers[0].name = 'Local name';
    remote.fleet.computers[0].name = 'Remote name';
    expect(() => mergeShared(base, local, remote)).toThrow('changed on both devices');
  });
  it('merges next-reply settings with an independently completing response on either host', () => {
    const base = emptyShared();
    const conversation = chat();
    conversation.settings.model = 'gpt-6-astra';
    conversation.settings.reasoning = 'low';
    conversation.messages.push({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant',
      createdAt: '',
      status: 'running',
      blocks: [],
      settings: { ...conversation.settings },
      modelName: 'GPT-6-Astra',
    });
    base.conversations.push(conversation);
    const edited = structuredClone(base),
      completed = structuredClone(base);
    edited.conversations[0].settings = {
      ...conversation.settings,
      model: 'gpt-5.6-sol',
      reasoning: 'high',
    };
    completed.conversations[0].messages[0].status = 'complete';
    completed.conversations[0].messages[0].blocks = [
      { type: 'markdown', text: 'Original model response' },
    ];
    for (const [local, remote] of [
      [edited, completed],
      [completed, edited],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].settings).toEqual(edited.conversations[0].settings);
      expect(merged.conversations[0].messages).toEqual(completed.conversations[0].messages);
    }
    // Two deliberate settings edits remain a conflict, never a silent last-writer choice.
    completed.conversations[0].settings.model = 'gpt-5.6-luna';
    expect(mergeShared(base, edited, completed).conversations).toHaveLength(2);
    completed.conversations[0].settings = { ...conversation.settings };
    completed.conversations[0].messages[0].settings!.model = 'a-different-in-flight-model';
    expect(mergeShared(base, edited, completed).conversations).toHaveLength(2);
  });
  it('exports shared content without local preferences or injected secrets', () => {
    const workspace = {
      ...initialWorkspace(),
      relayToken: 'not-a-real-token',
      installation: { id: 'private' },
    };
    const shared = sharedWorkspace(workspace);
    expect(Object.keys(shared).sort()).toEqual(['conversations', 'fleet']);
    expect(JSON.stringify(shared)).not.toContain('not-a-real-token');
  });
  it('never uses another connection’s quota reading, even when it is newer', () => {
    const settings = {
      ...settingsFor(initialWorkspace().preferences),
      connectionId: crypto.randomUUID(),
    };
    const reading: UsageSnapshot = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      checkedAt: 500,
      windows: [],
      context: null,
      detail: '',
    };
    expect(snapshotFor({ other: reading }, settings)).toBeUndefined();
  });
});
