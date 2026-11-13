// The workspace file, read from and saved to this computer's app a few megabytes at a time
// (src/lib/saved-parts.ts). On 2026-11-13 a 465 MB workspace, loaded as one text and written back
// as one by the first save of every start, filled the page's memory and the window loaded again,
// in a loop.
import { beforeEach, expect, it, vi } from 'vitest';
// What `$state` compiles to: the page's workspace is one of these proxies.
import { proxy } from 'svelte/internal/client';
import { liveField } from './detached';
import {
  conversationSchema,
  initialWorkspace,
  interruptedReplyError,
  type Conversation,
  type Workspace,
} from './domain';

const moved = 'The saved file changed while it was read.';
const needsWhole = 'The whole workspace is needed to save this change.';

type Call = { command: string; args: any; bytes: boolean };
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => native.invoke(command, args),
  isTauri: () => true,
  Channel: class {},
}));
// How much one call carries, which these tests make small.
const budget = vi.hoisted(() => ({ bytes: undefined as number | undefined }));
vi.mock('./saved-parts', async (original) => {
  const actual = await original<typeof import('./saved-parts')>();
  return {
    ...actual,
    chatChunks: (chats: Iterable<Conversation>, options?: { keep?: boolean }) =>
      actual.chatChunks(chats, { ...options, budget: budget.bytes }),
    readChats: (
      chats: [string, number][],
      read: (ids: string[]) => Promise<unknown>,
      take: (list: unknown[]) => unknown,
    ) => actual.readChats(chats, read, take, budget.bytes),
  };
});

const uuid = (kind: number, n: number) =>
  `00000000-0000-4000-${kind}000-${String(n).padStart(12, '0')}`;
const chat = (n: number, status: 'complete' | 'running' = 'complete'): Conversation =>
  conversationSchema.parse({
    id: uuid(8, n),
    title: `Chat ${n} é 😀`,
    createdAt: '2026-11-13',
    updatedAt: '2026-11-13',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: uuid(9, n),
        role: 'assistant',
        blocks: [{ type: 'markdown', text: `Answer ${n} `.repeat(20) }],
        status,
        createdAt: '2026-11-13',
      },
    ],
  });
const workspaceOf = (chats: Conversation[]): Workspace => ({
  ...initialWorkspace(),
  conversations: chats,
});

/** This computer's app, as far as it keeps the workspace file (src-tauri/src/parts.rs). */
function app(file?: Workspace, { parts = true } = {}) {
  const text = (c: Conversation) => JSON.stringify(c);
  const state = {
    index: undefined as Record<string, unknown> | undefined,
    order: [] as string[],
    saved: undefined as Map<string, string> | undefined,
    written: 0,
    staged: undefined as { save: string; chats: Map<string, string> } | undefined,
    calls: [] as Call[],
    // Failures to answer with, each once.
    fail: [] as { command: string; reason: string }[],
  };
  if (file) {
    const { conversations, ...index } = file;
    state.index = index;
    state.order = conversations.map((c) => c.id);
    if (parts) state.saved = new Map(conversations.map((c) => [c.id, text(c)]));
  }
  const whole = () =>
    state.index && {
      ...state.index,
      conversations: state.order.map((id) => JSON.parse(state.saved?.get(id) ?? fileText.get(id)!)),
    };
  // What the file holds, which an app that reads it whole keeps nothing of.
  const fileText = new Map((file?.conversations ?? []).map((c) => [c.id, text(c)]));
  const write = (index: Record<string, unknown>, chats: Map<string, string>, order: string[]) => {
    state.index = index;
    state.saved = new Map(order.map((id) => [id, chats.get(id)!]));
    state.order = order;
    state.written++;
  };
  native.invoke.mockImplementation(async (command: string, sent?: unknown) => {
    const bytes = sent instanceof Uint8Array;
    const args = bytes ? JSON.parse(new TextDecoder().decode(sent)) : (sent as any);
    state.calls.push({ command, args, bytes });
    const failure = state.fail.findIndex((f) => f.command === command);
    if (failure >= 0) throw state.fail.splice(failure, 1)[0].reason;
    switch (command) {
      case 'open_workspace':
        if (!parts) return file ? null : { whole: null };
        if (!state.saved) return { whole: null };
        return {
          parts: {
            rest: state.index,
            chats: state.order.map((id) => [id, state.saved!.get(id)!.length]),
            read: state.written,
          },
        };
      case 'load_workspace':
        return whole() ?? null;
      case 'read_workspace_chats': {
        if (args.read !== state.written || !state.saved) throw moved;
        const list = args.ids.map((id: string) => state.saved!.get(id));
        if (list.includes(undefined)) throw moved;
        return new TextEncoder().encode(`[${list.join(',')}]`).buffer;
      }
      case 'stage_workspace_chats':
        if (state.staged?.save !== args.save) state.staged = { save: args.save, chats: new Map() };
        for (const c of args.upsert) state.staged!.chats.set(c.id, text(c));
        return null;
      case 'save_workspace_patch': {
        const held = state.staged;
        state.staged = undefined;
        if (args.staged !== undefined && held?.save !== args.staged) throw needsWhole;
        const chats = new Map(args.staged === undefined ? [] : held!.chats);
        for (const c of args.upsert) chats.set(c.id, text(c));
        if ([...chats.keys()].some((id) => !args.order.includes(id))) throw needsWhole;
        for (const id of args.order)
          if (!chats.has(id)) {
            const kept = state.saved?.get(id);
            if (kept === undefined) throw needsWhole;
            chats.set(id, kept);
          }
        write(args.index, chats, args.order);
        return null;
      }
      case 'save_workspace': {
        const { conversations, ...index } = args.workspace;
        write(
          index,
          new Map(conversations.map((c: Conversation) => [c.id, text(c)])),
          conversations.map((c: Conversation) => c.id),
        );
        return null;
      }
    }
    return null;
  });
  return {
    state,
    /** The conversations the file now holds, in order. */
    held: () => state.order.map((id) => JSON.parse(state.saved!.get(id)!) as Conversation),
    calls: (...commands: string[]) => state.calls.filter((c) => commands.includes(c.command)),
    names: () =>
      state.calls
        .map((c) => c.command)
        .filter((c) => /workspace/.test(c))
        .join(' '),
  };
}

beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  budget.bytes = undefined;
});

it('reads the workspace a few conversations at a time', async () => {
  const chats = [chat(1), chat(2, 'running'), chat(3), chat(4)];
  const host = app(workspaceOf(chats));
  // Room for two conversations a read.
  budget.bytes = JSON.stringify(chats[0]).length * 2 + 8;
  const transport = await import('./transport');
  const loaded: { unsaved?: Set<string> } = {};
  const workspace = await transport.loadWorkspace(undefined, [], loaded);
  expect(host.calls('read_workspace_chats').map((c) => c.args.ids)).toEqual([
    [chats[0].id, chats[1].id],
    [chats[2].id, chats[3].id],
  ]);
  expect(host.calls('load_workspace')).toEqual([]);
  expect(workspace.conversations.map((c) => c.title)).toEqual(chats.map((c) => c.title));
  expect(workspace.conversations[1].messages[0]).toMatchObject({
    status: 'cancelled',
    error: interruptedReplyError,
  });
  // The app holds the file's conversations, so the first save sends the one restoring changed.
  expect([...loaded.unsaved!]).toEqual([chats[1].id]);
});

it('reads the workspace again when a save replaced the file between two reads', async () => {
  const chats = [chat(1), chat(2), chat(3)];
  const host = app(workspaceOf(chats));
  budget.bytes = 1;
  host.state.fail.push({ command: 'read_workspace_chats', reason: moved });
  const transport = await import('./transport');
  const workspace = await transport.loadWorkspace();
  expect(host.calls('open_workspace')).toHaveLength(2);
  expect(workspace.conversations.map((c) => c.id)).toEqual(chats.map((c) => c.id));
  // Any other failure is the load's own, and a file that keeps changing is no endless wait.
  host.state.fail.push({ command: 'read_workspace_chats', reason: 'Storage lock failed' });
  await expect(transport.loadWorkspace()).rejects.toBe('Storage lock failed');
  for (let i = 0; i < 5; i++)
    host.state.fail.push({ command: 'read_workspace_chats', reason: moved });
  await expect(transport.loadWorkspace()).rejects.toBe(moved);
});

it('reads the workspace whole from an app that hands it over so', async () => {
  const chats = [chat(1), chat(2, 'running')];
  // An app that only knows the whole file answers nothing when asked to open it.
  const host = app(workspaceOf(chats), { parts: false });
  const transport = await import('./transport');
  const loaded: { unsaved?: Set<string> } = {};
  const workspace = await transport.loadWorkspace(undefined, [], loaded);
  expect(host.names()).toBe('open_workspace load_workspace');
  expect(workspace.conversations.map((c) => c.id)).toEqual(chats.map((c) => c.id));
  // Nothing says the app can complete a save from the file: the first save sends everything.
  expect(loaded.unsaved).toBeUndefined();
  // No file at all.
  app();
  const fresh = await transport.loadWorkspace(undefined, [], loaded);
  expect(fresh.conversations).toEqual([]);
  expect(loaded.unsaved).toBeUndefined();
});

it('saves every conversation in one call while they fit, as detached copies', async () => {
  const chats = [chat(1), chat(2)];
  const host = app();
  const transport = await import('./transport');
  const target = workspaceOf(chats);
  const live = proxy(target);
  const copies: Conversation[] = [];
  await transport.saveWorkspace(live, undefined, undefined, undefined, (c) => {
    const copy = structuredClone(chats.find((own) => own.id === liveField(c, 'id'))!);
    copies.push(copy);
    return copy;
  });
  const [save] = host.calls('save_workspace');
  expect(host.names()).toBe('save_workspace');
  expect(save.bytes).toBe(false);
  expect(save.args.workspace.conversations).toEqual(copies);
  expect(save.args.workspace.conversations[0]).toBe(copies[0]);
  expect(host.held()).toEqual(chats);
  // Writing live conversations as text made every part of them reactive: no conversation's
  // messages were read through the page's state.
  for (const conversation of target.conversations)
    expect(
      liveField(
        liveField(target.conversations, target.conversations.indexOf(conversation)) as object,
        'messages',
      ),
    ).toBe(conversation.messages);
});

it('sends every conversation ahead, a few at a time, once one call cannot carry them', async () => {
  const chats = [1, 2, 3, 4, 5, 6, 7].map((n) => chat(n));
  const host = app();
  budget.bytes = JSON.stringify(chats[0]).length * 2 + 8;
  const transport = await import('./transport');
  const made: string[] = [];
  await transport.saveWorkspace(workspaceOf(chats), undefined, undefined, undefined, (c) => {
    made.push(`${c.id} after ${host.calls('stage_workspace_chats').length}`);
    return structuredClone(c);
  });
  expect(host.names()).toBe(`${'stage_workspace_chats '.repeat(4)}save_workspace_patch`);
  const staged = host.calls('stage_workspace_chats');
  expect(staged.every((call) => call.bytes)).toBe(true);
  expect(staged.map((call) => call.args.upsert.map((c: Conversation) => c.id))).toEqual([
    [chats[0].id, chats[1].id],
    [chats[2].id, chats[3].id],
    [chats[4].id, chats[5].id],
    [chats[6].id],
  ]);
  // One name for the whole save, which its last call gives with the order and nothing else.
  const [patch] = host.calls('save_workspace_patch');
  expect(new Set(staged.map((call) => call.args.save))).toEqual(new Set([patch.args.staged]));
  expect(patch.args).toMatchObject({ upsert: [], order: chats.map((c) => c.id) });
  expect(patch.args.index).toMatchObject({ version: 3 });
  expect(patch.args.index.conversations).toBeUndefined();
  expect(host.held()).toEqual(chats);
  // Each copy was made as its turn came, a list or two ahead of the one being sent, never all
  // of them first.
  expect(made[0]).toBe(`${chats[0].id} after 0`);
  expect(made.at(-1)).toMatch(new RegExp(`^${chats[6].id} after [1-3]$`));
});

it('sends only the conversations that changed, and all of them when the app asks', async () => {
  const chats = [chat(1), chat(2), chat(3)];
  const host = app(workspaceOf(chats));
  const transport = await import('./transport');
  const renamed = { ...chats[1], title: 'Renamed' };
  const workspace = workspaceOf([chats[0], renamed, chats[2]]);
  await transport.saveWorkspace(workspace, undefined, [renamed], [renamed]);
  expect(host.names()).toBe('save_workspace_patch');
  const [patch] = host.calls('save_workspace_patch');
  expect(patch.bytes).toBe(true);
  expect(patch.args.upsert).toEqual([renamed]);
  expect(patch.args.staged).toBeUndefined();
  expect(host.held().map((c) => c.title)).toEqual([chats[0].title, 'Renamed', chats[2].title]);
  // An app that kept nothing of its last write cannot complete the save.
  host.state.saved = undefined;
  host.state.calls.length = 0;
  await transport.saveWorkspace(workspace, undefined, [renamed], [renamed]);
  expect(host.names()).toBe('save_workspace_patch save_workspace');
  expect(host.held().map((c) => c.title)).toEqual([chats[0].title, 'Renamed', chats[2].title]);
  // And in parts once they no longer fit one call.
  host.state.saved = undefined;
  host.state.calls.length = 0;
  budget.bytes = 1;
  await transport.saveWorkspace(workspace, undefined, [], []);
  expect(host.names()).toBe(
    'save_workspace_patch stage_workspace_chats stage_workspace_chats stage_workspace_chats save_workspace_patch',
  );
  expect(host.held().map((c) => c.title)).toEqual([chats[0].title, 'Renamed', chats[2].title]);
});

it('sends many changed conversations ahead too', async () => {
  const chats = [chat(1), chat(2), chat(3), chat(4)];
  const host = app(workspaceOf(chats));
  budget.bytes = 1;
  const transport = await import('./transport');
  const changed = chats.slice(1).map((c) => ({ ...c, title: `${c.title} again` }));
  await transport.saveWorkspace(workspaceOf([chats[0], ...changed]), undefined, changed, changed);
  expect(host.names()).toBe(
    'stage_workspace_chats stage_workspace_chats stage_workspace_chats save_workspace_patch',
  );
  expect(host.held().map((c) => c.title)).toEqual([chats[0].title, ...changed.map((c) => c.title)]);
  // A save whose conversations the app no longer holds is told so, and sends everything.
  host.state.fail.push({ command: 'save_workspace_patch', reason: needsWhole });
  host.state.calls.length = 0;
  await transport.saveWorkspace(
    workspaceOf([chats[0], ...changed]),
    undefined,
    [changed[0]],
    [changed[0]],
  );
  expect(host.calls('save_workspace_patch')).toHaveLength(2);
  expect(host.calls('stage_workspace_chats')).toHaveLength(4);
  // Any other failure is the save's own.
  host.state.fail.push({ command: 'stage_workspace_chats', reason: 'Storage lock failed' });
  await expect(
    transport.saveWorkspace(workspaceOf([chats[0], ...changed]), undefined, changed, changed),
  ).rejects.toBe('Storage lock failed');
});

it('sends plain arguments, never live conversations, once Tauri carries calls as JSON', async () => {
  const chats = [chat(1), chat(2), chat(3)];
  const host = app(workspaceOf(chats));
  const transport = await import('./transport');
  const { watchIpcFallback } = await import('./window-answers');
  const quiet = { warn: (..._args: unknown[]) => {} };
  watchIpcFallback(() => {}, quiet);
  quiet.warn('IPC custom protocol failed, Tauri will now use the postMessage interface instead');
  const target = workspaceOf(chats);
  const live = proxy(target);
  // No copies came with the change: the conversations still go as detached ones.
  await transport.saveWorkspace(live, undefined, [live.conversations[1]]);
  const [patch] = host.calls('save_workspace_patch');
  expect(patch.bytes).toBe(false);
  expect(patch.args.upsert).toEqual([chats[1]]);
  expect(patch.args.upsert[0]).not.toBe(live.conversations[1]);
  expect(liveField(target.conversations[1], 'messages')).toBe(chats[1].messages);
  // In parts, each call plain.
  budget.bytes = 1;
  host.state.calls.length = 0;
  await transport.saveWorkspace(live);
  expect(host.names()).toBe(
    'stage_workspace_chats stage_workspace_chats stage_workspace_chats save_workspace_patch',
  );
  expect(host.state.calls.filter((c) => /workspace/.test(c.command)).every((c) => !c.bytes)).toBe(
    true,
  );
  expect(host.held()).toEqual(chats);
});
