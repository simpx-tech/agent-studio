import { expect, it } from 'vitest';
import { createDesktopNotificationTracker, questionGrace } from './desktop-notifications';
import { interruptedReplyError } from './domain';
import type { Conversation, Message } from './domain';

const time = Date.now();
function chat(status: Message['status'] = 'running', createdAt = time): Conversation {
  return {
    id: crypto.randomUUID(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        runId: crypto.randomUUID(),
        status,
        createdAt: new Date(createdAt).toISOString(),
        blocks: [],
      },
    ],
  } as unknown as Conversation;
}
function question(c: Conversation, parentId?: string) {
  c.messages[0].blocks.push({
    type: 'activity',
    text: 'Question',
    tool: {
      id: crypto.randomUUID(),
      name: 'mcp.request_user_input_async',
      parentId,
      status: 'running',
      category: 'tool',
      revision: 1,
    },
  } as Message['blocks'][number]);
}
it('does not notify on initial history, archival changes, title updates or old imports', () => {
  const observe = createDesktopNotificationTracker(() => time);
  const old = chat('complete', time - 1000);
  expect(observe({ conversations: [old] })).toEqual([]);
  old.archived = true;
  expect(observe({ conversations: [old, chat('complete', time - 86_400_000)] })).toEqual([]);
});
it('delivers every terminal kind once across repeated checkpoints and stale running snapshots', () => {
  const observe = createDesktopNotificationTracker(() => time);
  observe({ conversations: [] });
  const conversations = [chat(), chat(), chat()];
  expect(observe({ conversations })).toEqual([]);
  for (const [i, kind] of (['complete', 'error', 'cancelled'] as const).entries())
    conversations[i].messages[0].status = kind;
  const result = observe({ conversations });
  expect(result.map((n) => n.kind)).toEqual(['complete', 'error', 'cancelled']);
  expect(result.map((n) => n.conversationId)).toEqual(conversations.map((c) => c.id));
  expect(observe({ conversations })).toEqual([]);
  conversations[0].messages[0].status = 'running';
  question(conversations[0]);
  expect(observe({ conversations })).toEqual([]);
  conversations[0].messages[0].status = 'complete';
  expect(observe({ conversations })).toEqual([]);
});
it('notifies for explicit parent questions once, then completion, but never child activity or prose', () => {
  let clock = time;
  const observe = createDesktopNotificationTracker(() => clock);
  observe({ conversations: [] });
  const c = chat();
  c.messages[0].blocks.push({ type: 'markdown', text: 'A question?' });
  question(c, 'child');
  expect(observe({ conversations: [c] })).toEqual([]);
  question(c);
  // A question tool alone waits a moment for its question, then alerts on its own.
  expect(observe({ conversations: [c] })).toEqual([]);
  clock += questionGrace;
  expect(observe({ conversations: [c] }).map((n) => n.kind)).toEqual(['attention']);
  expect(observe({ conversations: [c] })).toEqual([]);
  c.messages[0].status = 'complete';
  expect(observe({ conversations: [c] }).map((n) => n.kind)).toEqual(['complete']);
});
it('names the chat and starts with its reply in each notice', () => {
  let clock = time;
  const observe = createDesktopNotificationTracker(() => clock);
  observe({ conversations: [] });
  const c = chat();
  c.title = 'Fix the login flow';
  question(c);
  observe({ conversations: [c] });
  clock += questionGrace;
  const [attention] = observe({ conversations: [c] });
  expect(attention).toMatchObject({
    kind: 'attention',
    title: 'Fix the login flow',
    body: 'Your agent asked for your input.',
  });
  c.messages[0].blocks.push({ type: 'markdown', text: 'The **session** now survives reloads.' });
  c.messages[0].status = 'complete';
  expect(observe({ conversations: [c] })).toEqual([
    {
      kind: 'complete',
      conversationId: c.id,
      tag: `${c.messages[0].runId}:terminal`,
      title: 'Fix the login flow',
      body: 'The session now survives reloads.',
    },
  ]);
});
it('alerts with the question a question tool records a moment after it starts', () => {
  let clock = time;
  const wakes: number[] = [];
  const observe = createDesktopNotificationTracker(
    () => clock,
    (delay) => wakes.push(delay),
  );
  observe({ conversations: [] });
  const c = chat();
  question(c);
  expect(observe({ conversations: [c] })).toEqual([]);
  // The window is asked to look again once the wait is over.
  expect(wakes).toEqual([questionGrace]);
  clock += 2_000;
  c.messages[0].questions = [
    {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'q',
          header: 'Branch',
          question: 'Merge into main?',
          options: [],
          multiSelect: false,
        },
      ],
    },
  ];
  const notices = observe({ conversations: [c] });
  expect(notices.map((n) => n.body)).toEqual(['Question: Merge into main?']);
  clock += questionGrace;
  expect(observe({ conversations: [c] })).toEqual([]);
});

it('alerts for a reply restored as interrupted once another computer finishes it', () => {
  // The window starts while the reply runs elsewhere: its saved copy reads interrupted.
  const c = chat('cancelled', time - 30_000);
  c.messages[0].error = interruptedReplyError;
  const observe = createDesktopNotificationTracker(() => time);
  expect(observe({ conversations: [c] })).toEqual([]);
  // Sync brings the running copy back, and later its end.
  c.messages[0].status = 'running';
  c.messages[0].error = undefined;
  expect(observe({ conversations: [c] })).toEqual([]);
  c.messages[0].status = 'complete';
  expect(observe({ conversations: [c] }).map((n) => n.kind)).toEqual(['complete']);
});

it('alerts for a long reply first seen finished, and never twice across thousands of chats', () => {
  let clock = time;
  const observe = createDesktopNotificationTracker(() => clock);
  observe({ conversations: [] });
  // A reply that ran twenty minutes while this computer slept is still news.
  clock += 30 * 60_000;
  expect(observe({ conversations: [chat('complete', time + 60_000)] })).toHaveLength(1);
  const many = Array.from({ length: 3000 }, () => chat('complete', clock - 1000));
  expect(observe({ conversations: many })).toHaveLength(3000);
  for (let pass = 0; pass < 3; pass++) expect(observe({ conversations: many })).toEqual([]);
});

it('handles fast remote completion without a running checkpoint and excludes future timestamps', () => {
  const observe = createDesktopNotificationTracker(() => time);
  observe({ conversations: [] });
  expect(observe({ conversations: [chat('complete')] })).toHaveLength(1);
  expect(observe({ conversations: [chat('complete', time + 5000)] })).toHaveLength(0);
});
it('keeps known long-running tasks eligible and only inspects the current reply', () => {
  let clock = time;
  const observe = createDesktopNotificationTracker(() => clock);
  const c = chat('running', time - 50_000);
  observe({ conversations: [c] });
  clock += 3_600_000;
  c.messages[0].status = 'complete';
  expect(observe({ conversations: [c] })).toHaveLength(1);
  c.messages.push({
    ...c.messages[0],
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    createdAt: new Date(clock).toISOString(),
    status: 'running',
  });
  expect(observe({ conversations: [c] })).toHaveLength(0);
});
