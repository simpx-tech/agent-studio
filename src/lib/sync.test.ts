import { describe, expect, it } from 'vitest';
import {
  initialWorkspace,
  interruptedReplyError,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Message,
} from './domain';
import {
  emptyShared,
  mergeShared,
  onlyRepliesMoved,
  replaceFields,
  sameShared,
  sharedSchema,
  sharedWorkspace,
} from './sync';
import { registerInstallation } from './fleet';
import { sameFolderIcons } from './folder-icons';
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
  it('compares shared workspaces by item, whatever order each device keeps', () => {
    const first = chat(),
      second = chat();
    const local = { ...emptyShared(), conversations: [second, first] };
    const merged = { ...emptyShared(), conversations: [first, second] };
    expect(sameShared(local, merged)).toBe(true);
    expect(sameShared(local, { ...merged, conversations: [first] })).toBe(false);
    expect(sameShared(local, { ...merged, conversations: [first, first] })).toBe(false);
    expect(
      sameShared(local, { ...merged, conversations: [first, { ...second, title: 'Renamed' }] }),
    ).toBe(false);
    expect(sameShared(local, { ...merged, claudeInstructions: '' })).toBe(false);
  });
  it('syncs app sessions and keeps them when the relay predates them', () => {
    const session = (hour: number) => ({
      id: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      startedAt: new Date(2026, 8, 25, hour).toISOString(),
    });
    const [kept, ours, theirs] = [session(8), session(9), session(10)];
    const base = { ...emptyShared(), appSessions: [kept] };
    const local = { ...base, appSessions: [kept, ours] };
    const remote = { ...base, appSessions: [kept, theirs] };
    expect(mergeShared(base, local, remote).appSessions).toEqual([kept, ours, theirs]);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(sharedSchema.parse(local).appSessions).toEqual(local.appSessions);
    expect(mergeShared(base, local, older).appSessions).toEqual(local.appSessions);
    expect(sameShared(older, local)).toBe(true);
    // A relay that holds sessions this device lacks, or other ones, differs.
    expect(sameShared(remote, emptyShared())).toBe(false);
    expect(sameShared(remote, local)).toBe(false);
    expect(sameShared(local, { ...local, appSessions: [ours, kept] })).toBe(true);
    // No list stays absent, as older relays store it.
    expect('appSessions' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
  });
  it('syncs folder icons and keeps them when the relay predates them', () => {
    const icon = (path: string, name: string) => ({
      environmentId: crypto.randomUUID(),
      path,
      icon: name,
      chosenAt: new Date(2026, 9, 2).toISOString(),
    });
    const [kept, ours, theirs] = [
      icon('/kept', 'code'),
      icon('/ours', 'bot'),
      icon('/theirs', 'map'),
    ];
    const base = { ...emptyShared(), folderIcons: [kept] };
    const local = { ...base, folderIcons: [kept, ours] };
    const remote = { ...base, folderIcons: [kept, theirs] };
    expect(
      sameFolderIcons(mergeShared(base, local, remote).folderIcons, [kept, ours, theirs]),
    ).toBe(true);
    // An older relay drops the list; this device keeps its own and sees no difference.
    const older = emptyShared();
    expect(sharedSchema.parse(local).folderIcons).toEqual(local.folderIcons);
    expect(mergeShared(base, local, older).folderIcons).toEqual(local.folderIcons);
    expect(sameShared(older, local)).toBe(true);
    // A relay that holds icons this device lacks, or other ones, differs.
    expect(sameShared(remote, emptyShared())).toBe(false);
    expect(sameShared(remote, local)).toBe(false);
    expect(sameShared(local, { ...local, folderIcons: [ours, kept] })).toBe(true);
    // No list stays absent, as older relays store it, and a saved workspace keeps its icons.
    expect('folderIcons' in mergeShared(emptyShared(), emptyShared(), older)).toBe(false);
    const saved = restoreWorkspace({ ...initialWorkspace(), folderIcons: local.folderIcons });
    expect(saved.folderIcons).toEqual(local.folderIcons);
    expect(sharedWorkspace(saved).folderIcons).toEqual(local.folderIcons);
  });
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
  it('keeps the later copy of a reply whose answer started over, instead of copying the chat', () => {
    // A long reply writes its earlier text down as a progress comment when it calls a tool, and
    // its answer starts again, so a copy from an earlier step holds text the later one no longer
    // extends. A phone that saw that step merged it with the finished reply as a conflict copy.
    const runId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const step = (steps: number, text: string) => ({
      id: replyId,
      runId,
      role: 'assistant' as const,
      createdAt: '',
      status: 'running' as const,
      blocks: [
        { type: 'markdown' as const, text },
        ...Array.from({ length: steps }, (_, i) => ({
          type: 'activity' as const,
          text: `Progress ${i}`,
          order: i + 1,
          progress: { id: `progress-${i}`, revision: 0 },
        })),
      ],
    });
    const at = (message: Message) => {
      const shared = emptyShared();
      shared.conversations.push({ ...chat(), id: 'chat', messages: [message] });
      return shared;
    };
    const base = at(step(1, 'The fourth round'));
    const earlier = at(step(2, 'The fourth round is running. Before starting it, I reorganised'));
    const later = at({ ...step(4, 'Round 4 is still running.'), status: 'complete' as const });
    const running = at(step(4, 'Round 4 is still running.'));
    for (const [local, remote] of [
      [earlier, later],
      [later, earlier],
      [earlier, running],
      [running, earlier],
    ]) {
      const merged = mergeShared(base, local, remote);
      const newer = local === earlier ? remote : local;
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].messages[0].status).toBe(
        newer.conversations[0].messages[0].status,
      );
      expect(merged.conversations[0].messages[0].blocks).toEqual(
        newer.conversations[0].messages[0].blocks,
      );
    }
    // A copy an older Viewer restored as interrupted yields to the finished one the same way.
    const stopped = at({
      ...step(2, 'The fourth round is running.'),
      status: 'cancelled' as const,
      error: interruptedReplyError,
    });
    const finished = mergeShared(base, stopped, later).conversations;
    expect(finished).toHaveLength(1);
    expect(finished[0].messages[0]).toMatchObject({ status: 'complete' });
    expect(finished[0].messages[0].error).toBeUndefined();
    // Copies at the same step whose answers differ take the relay's, which its computer published.
    const theirs = at(step(2, 'Round 4 is running.'));
    expect(mergeShared(base, earlier, theirs).conversations).toEqual(theirs.conversations);
  });
  it('keeps an account switched on one device with the reply another device saw end', () => {
    // A reply hit a usage limit; the desktop switched the chat to another account and went on,
    // while a phone still held the first account and the reply as it was before.
    const first = crypto.randomUUID(),
      second = crypto.randomUUID();
    const conversation = chat();
    conversation.settings.connectionId = first;
    const reply = {
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      role: 'assistant' as const,
      createdAt: '',
      status: 'running' as const,
      settings: { ...conversation.settings },
      blocks: [{ type: 'markdown' as const, text: 'Working' }],
    };
    conversation.messages.push(reply);
    const base = { ...emptyShared(), conversations: [conversation] };
    const phone = structuredClone(base);
    phone.conversations[0].messages[0] = {
      ...reply,
      status: 'cancelled',
      error: interruptedReplyError,
    };
    const desktop = structuredClone(base);
    const switched = desktop.conversations[0];
    switched.settings.connectionId = second;
    switched.messages[0] = { ...reply, status: 'error', error: 'You hit your session limit.' };
    switched.messages.push(
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Continue from where you stopped' }],
      },
      {
        ...reply,
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        status: 'complete',
        settings: { ...switched.settings },
        blocks: [{ type: 'markdown', text: 'Continued.' }],
      },
    );
    for (const [local, remote] of [
      [phone, desktop],
      [desktop, phone],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].settings.connectionId).toBe(second);
      expect(merged.conversations[0].messages).toEqual(switched.messages);
    }
    // Switching to two different accounts is still a conflict, never a silent choice.
    const elsewhere = structuredClone(phone);
    elsewhere.conversations[0].settings.connectionId = crypto.randomUUID();
    expect(mergeShared(base, elsewhere, desktop).conversations).toHaveLength(2);
  });
  it('tells a reply moving on from any other change, which the checkpoint must hold at once', () => {
    const conversation = chat();
    conversation.messages.push(
      {
        id: crypto.randomUUID(),
        role: 'user',
        createdAt: '',
        status: 'complete',
        blocks: [{ type: 'markdown', text: 'Go' }],
      },
      {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        createdAt: '',
        status: 'running',
        blocks: [{ type: 'markdown', text: 'Wor' }],
      },
    );
    const moved = structuredClone(conversation);
    moved.messages[1] = {
      ...moved.messages[1],
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Worked' }],
    };
    moved.updatedAt = '2026-10-09';
    expect(onlyRepliesMoved(conversation, moved)).toBe(true);
    expect(onlyRepliesMoved(conversation, structuredClone(conversation))).toBe(true);
    const changes: ((c: Conversation) => void)[] = [
      (c) => c.messages.push({ ...c.messages[0], id: crypto.randomUUID() }),
      (c) => c.messages.pop(),
      (c) => (c.messages[1] = { ...c.messages[1], id: crypto.randomUUID() }),
      (c) => (c.messages[0] = { ...c.messages[0], blocks: [{ type: 'markdown', text: 'Stop' }] }),
      (c) => (c.historyRevision = 1),
      (c) => (c.archived = true),
      (c) => (c.title = 'Renamed'),
      (c) => (c.settings = { ...c.settings, model: 'another' }),
    ];
    for (const change of changes) {
      const changed = structuredClone(conversation);
      change(changed);
      expect(onlyRepliesMoved(conversation, changed)).toBe(false);
    }
    // A conversation new to this device is a change of its own.
    expect(onlyRepliesMoved(undefined, conversation)).toBe(false);
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

it('replaces fields in place and drops the ones the copy no longer has', () => {
  // A device kept a removed Undo rewind this way, then published it back to every other one.
  const live: Record<string, unknown> = {
    id: 'a',
    title: 'Old',
    rewind: { removed: [] },
    archived: true,
  };
  const held = live;
  replaceFields(live, { id: 'a', title: 'New', archived: false });
  expect(live).toBe(held);
  expect(live).toEqual({ id: 'a', title: 'New', archived: false });
  expect('rewind' in live).toBe(false);
});
