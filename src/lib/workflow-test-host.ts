import type { Conversation, Message } from './domain';
import type { Fleet } from './fleet';
import type { UsageSnapshot } from './usage';
import { RunDriver, type ChatSpec, type WorkflowHost } from './workflow-engine';
import { readRun, type WorkflowDefinition, type WorkflowRun } from './workflow-model';
import { memoryFiles, workflowStore } from './workflow-store';

/** A page for workflow tests: chats that reply when told, accounts, usage and a clock. */
export function testHost(options: { environmentId?: string } = {}) {
  let clock = Date.parse('2026-10-16T12:00:00Z');
  const environmentId = options.environmentId ?? '11111111-1111-4111-8111-111111111111';
  const computerId = '22222222-2222-4222-8222-222222222222';
  const conversations = new Map<string, Conversation>();
  const runs = new Map<string, WorkflowRun>();
  const definitions = new Map<string, { body: WorkflowDefinition; revision: number }>();
  const usage = new Map<string, UsageSnapshot>();
  const offline = new Set<string>();
  const notReady = new Map<string, string>();
  const started: ChatSpec[] = [];
  const sent: { conversationId: string; text: string }[] = [];
  const steered: { conversationId: string; text: string }[] = [];
  const released: string[] = [];
  const switched: { conversationId: string; connectionId: string }[] = [];
  const connections = [
    'aaaaaaaa-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000002',
  ];
  const fleet: Fleet = {
    computers: [{ id: computerId, name: 'Desktop' }],
    environments: [{ id: environmentId, computerId, name: 'Desktop', platform: 'windows' }],
    accounts: [
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        name: 'Work',
        provider: 'claude',
        purpose: 'personal',
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        name: 'Home',
        provider: 'claude',
        purpose: 'personal',
      },
    ],
    connections: connections.map((id, i) => ({
      id,
      environmentId,
      accountId: `bbbbbbbb-0000-4000-8000-00000000000${i + 1}`,
      profile: 'isolated',
    })),
  };
  const message = (
    role: 'user' | 'assistant',
    text: string,
    status: Message['status'] = 'complete',
  ): Message => ({
    id: crypto.randomUUID(),
    role,
    blocks: role === 'user' || text ? [{ type: 'markdown', text }] : [],
    status,
    createdAt: new Date(clock).toISOString(),
    ...(role === 'assistant' ? { runId: crypto.randomUUID() } : {}),
  });
  const reply = (conversation: Conversation, text: string) => {
    const user = message('user', text);
    const answer = message('assistant', '', 'running');
    answer.settings = { ...conversation.settings };
    conversation.messages.push(user, answer);
    return answer.id;
  };
  const host: WorkflowHost = {
    self: () => ({ environmentId, computerId, server: false, name: 'Desktop' }),
    now: () => clock,
    fleet: () => fleet,
    online: (id) => !offline.has(id),
    conversation: (id) => conversations.get(id),
    conversations: () => [...conversations.values()],
    async startChat(spec) {
      started.push(spec);
      const conversation: Conversation = {
        id: spec.id,
        title: spec.title,
        settings: spec.settings,
        location: spec.location,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
        messages: [],
      };
      conversations.set(spec.id, conversation);
      return { replyId: reply(conversation, spec.text) };
    },
    async sendToChat(id, text) {
      sent.push({ conversationId: id, text });
      return { replyId: reply(conversations.get(id)!, text) };
    },
    async steerChat(id, text) {
      steered.push({ conversationId: id, text });
    },
    async stopChat(id) {
      const last = conversations.get(id)?.messages.at(-1);
      if (last?.status === 'running') last.status = 'cancelled';
    },
    releaseChat: (id) => void released.push(id),
    switchAccount(id, connectionId) {
      switched.push({ conversationId: id, connectionId });
      conversations.get(id)!.settings.connectionId = connectionId;
    },
    readiness: (settings) =>
      notReady.has(settings.connectionId ?? '')
        ? { ready: false, reason: notReady.get(settings.connectionId ?? '')! }
        : { ready: true },
    usage: (connectionId) => usage.get(connectionId ?? ''),
    refreshUsage: () => {},
    leastUsed: (_provider, _location, _model, exclude = []) =>
      connections.find((id) => !exclude.includes(id)),
    screens: {
      run: async (_e, _id, action, params) => ({
        exitCode: 0,
        stdout: JSON.stringify({ action, params }),
        stderr: '',
      }),
      load: async () => ({ progress: 3 }),
      save: async () => {},
    },
    createRun: async (id, run) => void runs.set(id, run),
    knownRun: (id) => runs.get(id),
    definition: async (id) => definitions.get(id),
    computers: () => [
      {
        environmentId,
        computerId,
        name: 'Desktop',
        platform: 'windows',
        online: !offline.has(environmentId),
        server: false,
        providers: ['claude', 'codex'],
        folders: ['C:\\game'],
      },
    ],
    accounts: () =>
      connections.map((connectionId, i) => ({
        connectionId,
        name: i ? 'Home' : 'Work',
        provider: 'claude' as const,
        environmentId,
        ready: true,
        detail: '',
      })),
  };
  const store = workflowStore(memoryFiles(), () => clock);
  const writer = {
    put: (id: string, expected: number, body: WorkflowRun, events: never[]) =>
      store.put({
        id,
        kind: 'run',
        expected,
        body: body as unknown as Record<string, unknown>,
        events,
      }),
  };
  return {
    host,
    store,
    writer,
    conversations,
    runs,
    definitions,
    usage,
    offline,
    notReady,
    started,
    sent,
    steered,
    released,
    switched,
    connections,
    environmentId,
    computerId,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    /** Ends a chat's running reply with `text`, or as the given status. */
    answer(
      conversationId: string,
      text: string,
      status: Message['status'] = 'complete',
      extra: Partial<Message> = {},
    ) {
      const last = conversations.get(conversationId)!.messages.at(-1)!;
      if (last.status !== 'running') throw new Error('No reply runs in that chat.');
      Object.assign(last, { status, blocks: [{ type: 'markdown', text }], ...extra });
    },
    /** A driver for a new run, saved to the store first. */
    async driver(run: WorkflowRun, id = crypto.randomUUID()) {
      const created = await store.put({
        id,
        kind: 'run',
        expected: null,
        body: run as unknown as Record<string, unknown>,
      });
      if (!created.ok) throw new Error('Could not create the run.');
      return new RunDriver(id, readRun(run)!, created.doc.revision, host, writer);
    },
  };
}
