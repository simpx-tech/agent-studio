import { createHmac, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import type { SharedWorkspace, RelayJob } from '../src/lib/sync.ts';
import type { Message } from '../src/lib/domain.ts';
import { toolActivitySchema } from '../src/lib/activity.ts';
import {
  attentionKeys,
  chatNotification,
  requestsAttention,
  type PushNotice,
} from '../src/lib/notifications.ts';
import { questionRequestSchema, type QuestionRequest } from '../src/lib/questions.ts';
import { elicitationReceiptSchema, type ElicitationReceipt } from '../src/lib/elicitations.ts';
import { proposedPlanSchema, type ProposedPlan } from '../src/lib/proposed-plans.ts';

const day = 24 * 60 * 60 * 1000;
// A phone alert waits this long for the chat to be opened on a computer instead. A reply
// often ends while its reader is at their desk with the app behind another window, where
// only its own notification shows it; the phone should ring for what they leave unread.
const hold = 20_000;
// Browser-supplied endpoints must never turn the relay into an HTTP proxy.
export function validPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname === 'web.push.apple.com' ||
        url.hostname.endsWith('.push.apple.com'))
    );
  } catch {
    return false;
  }
}
const base64 = (length: number) =>
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]+={0,2}$/)
    .refine((s) => Buffer.from(s, 'base64url').length === length);
export const subscriptionSchema = z.object({
  endpoint: z.string().max(4096).refine(validPushEndpoint),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: base64(65).refine((s) => Buffer.from(s, 'base64url')[0] === 4),
    auth: base64(16),
  }),
});
const noticeSchema = z.object({
  kind: z.enum(['complete', 'attention', 'error', 'cancelled', 'test']),
  conversationId: z.string().uuid().optional(),
  tag: z.string().max(100),
  // Bounded by chatNotification in code points; these limits count UTF-16 units.
  title: z.string().max(200).optional(),
  body: z.string().max(400).optional(),
});
const subscriberSchema = z.object({
  id: z.string().uuid(),
  session: z.string(),
  actor: z.string().uuid(),
  subject: z.string(),
  subscription: subscriptionSchema,
  lastError: z.boolean().default(false),
  lastSent: z.number().optional(),
  testAt: z.number().default(0),
});
const diskSchema = z.object({
  version: z.literal(1),
  keyId: z.string(),
  keys: z.object({ publicKey: base64(65), privateKey: base64(32) }),
  subscribers: z.array(subscriberSchema).max(1000),
  seen: z.array(z.tuple([z.string().max(120), z.number()])).max(4000),
  pending: z
    .array(
      z.object({
        id: z.string().uuid(),
        subscriber: z.string().uuid(),
        notice: noticeSchema,
        created: z.number().optional(),
        expires: z.number(),
        next: z.number(),
        attempts: z.number(),
      }),
    )
    .max(4000),
});
type State = z.infer<typeof diskSchema>;
type Reply = Parameters<typeof chatNotification>[2];

// A job can end before the execution host's final checkpoint reaches the relay. Its retained
// events hold the current answer (each text event repeats all of it), progress comments,
// proposed plans and any error.
function jobReply(
  job: RelayJob,
  questions: QuestionRequest[],
  elicitations: ElicitationReceipt[],
): Reply {
  const blocks: Message['blocks'] = [];
  const proposedPlans: ProposedPlan[] = [];
  let answer = '';
  let error = job.error;
  for (const event of job.events) {
    const value = event as { kind?: unknown; id?: unknown; text?: unknown; proposedPlan?: unknown };
    if (value?.kind === 'proposedplan') {
      const plan = proposedPlanSchema.safeParse(value.proposedPlan);
      if (plan.success) proposedPlans.push(plan.data);
    } else if (typeof value?.text === 'string') {
      if (value.kind === 'text') answer = value.text;
      else if (value.kind === 'progress' && typeof value.id === 'string')
        blocks.push({
          type: 'activity',
          text: value.text,
          progress: { id: value.id, revision: 0 },
        });
      else if (value.kind === 'error') error ??= value.text;
    }
  }
  if (answer) blocks.push({ type: 'markdown', text: answer });
  return { blocks, error, questions, elicitations, proposedPlans };
}
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export function pushService({
  directory,
  token,
  now,
  sessionActive,
  send = webpush.sendNotification,
  pendingCount,
  conversationTitle = () => undefined,
  active = () => true,
}: {
  directory: string;
  token: string;
  now: () => number;
  sessionActive: (session: string) => boolean;
  send?: PushSender;
  pendingCount?: () => number;
  // A job reports its run's events but not the title of the chat it belongs to.
  conversationTitle?: (conversationId: string) => string | undefined;
  active?: () => boolean;
}) {
  const file = join(directory, 'web-push.json');
  const keyId = createHmac('sha256', token).update('web-push-v1').digest('hex');
  let state: State;
  let saved = '';
  let unavailable = false;
  const views = new Map<
    string,
    {
      revision: number;
      conversationId: string | null;
      seenAt: number;
      session?: string;
    }
  >();
  // When each chat was last open in a visible, focused window, so an alert held for a
  // computer is dropped even when its reader has since moved on to another chat.
  const read = new Map<string, { at: number; session?: string }>();
  function viewing(notice: PushNotice): boolean {
    return (
      notice.kind !== 'test' &&
      !!notice.conversationId &&
      [...views.values()].some(
        (view) =>
          view.conversationId === notice.conversationId &&
          now() - view.seenAt < 15_000 &&
          (!view.session || sessionActive(view.session)),
      )
    );
  }
  function covered(item: State['pending'][number]): boolean {
    const id = item.notice.conversationId;
    if (!id) return false;
    if (viewing(item.notice)) return true;
    const last = read.get(id);
    return (
      !!last &&
      last.at >= (item.created ?? item.expires - day) &&
      (!last.session || sessionActive(last.session))
    );
  }
  function save(next: State) {
    // A rotated/disabled workspace can be replaced while a delivery is in
    // flight. Its old instance must never overwrite the replacement's file.
    if (!active()) throw new Error('Notification workspace is no longer active.');
    const bytes = JSON.stringify(next);
    if (bytes === saved) return;
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    state = next;
    saved = bytes;
    unavailable = false;
  }
  try {
    if (statSync(file).size > 10_000_000) throw new Error();
    state = diskSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    saved = JSON.stringify(state);
    if (state.keyId !== keyId) save({ ...state, keyId, subscribers: [], pending: [], seen: [] });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Push notification data is unreadable; preserved without overwriting.');
    state = {
      version: 1,
      keyId,
      keys: webpush.generateVAPIDKeys(),
      subscribers: [],
      pending: [],
      seen: [],
    };
    save(state);
  }
  function pruned(): State {
    const subscribers = state.subscribers.filter(
      (s) =>
        sessionActive(s.session) &&
        (s.subscription.expirationTime == null || s.subscription.expirationTime > now()),
    );
    return {
      ...state,
      subscribers,
      seen: state.seen.filter(([, expires]) => expires > now()),
      pending: state.pending.filter(
        (p) => p.expires > now() && subscribers.some((s) => s.id === p.subscriber),
      ),
    };
  }
  function enqueue(next: State, notice: PushNotice, receipt: string, only?: string) {
    if (next.seen.some(([key]) => key === receipt)) return;
    next.seen = [...next.seen.slice(-3999), [receipt, now() + day]];
    // Record the receipt even when read in foreground; never replay it on blur.
    if (viewing(notice)) return;
    for (const subscriber of next.subscribers) {
      if (only && subscriber.id !== only) continue;
      next.pending.push({
        id: randomUUID(),
        subscriber: subscriber.id,
        notice,
        created: now(),
        expires: now() + day,
        // A test is a button the reader is waiting on; chat alerts wait for the computer.
        next: notice.kind === 'test' ? now() : now() + hold,
        attempts: 0,
      });
    }
    // Keep bounded storage even if every push provider is offline for a day.
    next.pending = next.pending.slice(-4000);
  }
  let draining = false;
  let waking: ReturnType<typeof setTimeout> | undefined;
  // The server sweeps every ten seconds, which is coarse for a held alert. Wake at the
  // moment the next one is due so its delay stays the one this service decided on.
  function wake() {
    if (waking) clearTimeout(waking);
    waking = undefined;
    // Unwritable storage is the server's ten-second sweep to keep retrying, not this.
    if (unavailable) return;
    const due = state.pending.reduce(
      (soonest, p) => Math.min(soonest, p.next),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(due)) return;
    waking = setTimeout(
      () => {
        waking = undefined;
        void drain();
      },
      Math.min(60_000, Math.max(250, due - now())),
    );
    waking.unref();
  }
  async function drain() {
    if (draining || !active()) return;
    draining = true;
    try {
      save(pruned());
      // Bounded sequential delivery. No response bodies or endpoints in errors/logs.
      for (let count = 0; count < 20; count++) {
        const item = state.pending.find((p) => p.next <= now());
        if (!item) break;
        const subscriber = state.subscribers.find((s) => s.id === item.subscriber);
        if (!subscriber || !sessionActive(subscriber.session)) {
          save(pruned());
          continue;
        }
        // A reader may open the chat while the hold or a failed delivery waits.
        if (covered(item)) {
          save({ ...state, pending: state.pending.filter((p) => p.id !== item.id) });
          continue;
        }
        let failed = false,
          gone = false;
        try {
          // Read the current total for every attempt, including delayed retries.
          // Do not increment per notification: one chat can send several alerts.
          const notice = {
            ...item.notice,
            ...(pendingCount ? { pendingCount: pendingCount() } : {}),
          };
          await send(subscriber.subscription, JSON.stringify(notice), {
            TTL: Math.max(0, Math.floor((item.expires - now()) / 1000)),
            // A reply the reader is waiting for is time-sensitive: normal urgency lets a
            // push service hold it for a dozing phone until its next maintenance window,
            // which delivered alerts minutes after the answer they announce.
            urgency: 'high',
            timeout: 10_000,
            topic: createHmac('sha256', token)
              .update(item.notice.tag)
              .digest('base64url')
              .slice(0, 32),
            vapidDetails: { subject: subscriber.subject, ...state.keys },
          });
        } catch (error) {
          failed = true;
          gone = [404, 410].includes((error as { statusCode?: number }).statusCode ?? 0);
        }
        if (!active()) return;
        const next = pruned();
        const current = next.subscribers.find((s) => s.id === subscriber.id);
        if (
          current &&
          JSON.stringify(current.subscription) !== JSON.stringify(subscriber.subscription)
        ) {
          // A browser may renew its endpoint while an older delivery is in flight.
          // An old 410 must not revoke the replacement subscription.
          save(next);
          continue;
        }
        if (gone) {
          next.subscribers = next.subscribers.filter((s) => s.id !== subscriber.id);
          next.pending = next.pending.filter((p) => p.subscriber !== subscriber.id);
        } else {
          next.subscribers = next.subscribers.map((s) =>
            s.id === subscriber.id
              ? { ...s, lastError: failed, ...(failed ? {} : { lastSent: now() }) }
              : s,
          );
          next.pending = next.pending.flatMap((p) =>
            p.id !== item.id
              ? [p]
              : failed
                ? [
                    {
                      ...p,
                      attempts: p.attempts + 1,
                      next: now() + Math.min(300_000, 10_000 * 2 ** Math.min(p.attempts, 5)),
                    },
                  ]
                : [],
          );
        }
        save(next);
      }
    } catch {
      unavailable = true;
    } finally {
      draining = false;
      if (active()) wake();
    }
  }
  function changed(before: SharedWorkspace, after: SharedWorkspace) {
    try {
      const next = pruned();
      for (const conversation of after.conversations) {
        const previous = before.conversations.find((c) => c.id === conversation.id);
        const message = conversation.messages.at(-1);
        if (!message || message.role !== 'assistant' || !message.runId) continue;
        const old = previous?.messages.find((m) => m.id === message.id);
        // Ignore imported history and old checkpoint replays, but include fast
        // replies that finish between two relay syncs.
        const created = Date.parse(message.createdAt);
        if (
          !old &&
          (!Number.isFinite(created) || created < now() - 300_000 || created > now() + 60_000)
        )
          continue;
        const base = { conversationId: conversation.id, tag: `studio-${message.runId}` };
        if (message.status !== 'running' && (!old || old.status === 'running'))
          enqueue(
            next,
            {
              ...base,
              kind: message.status,
              ...chatNotification(message.status, conversation, message),
            },
            `${message.runId}:terminal`,
          );
        else if (message.status === 'running')
          for (const key of attentionKeys(message).filter(
            (key) => !old || !attentionKeys(old).includes(key),
          ))
            enqueue(
              next,
              {
                ...base,
                kind: 'attention',
                ...chatNotification('attention', conversation, message, key),
              },
              `${message.runId}:${key}`,
            );
      }
      save(next);
      void drain();
    } catch {
      unavailable = true;
    }
  }
  return {
    changed,
    drain,
    view(source: string, revision: number, conversationId: string | null, session?: string) {
      for (const [id, view] of views)
        if (now() - view.seenAt >= day || (view.session && !sessionActive(view.session)))
          views.delete(id);
      const old = views.get(source);
      if (old && revision <= old.revision) return;
      if (!old && views.size >= 1000) throw new Error('Notification view limit reached.');
      views.set(source, { revision, conversationId, seenAt: now(), session });
      if (!conversationId || (session && !sessionActive(session))) return;
      // Newest last, so the oldest records are the ones this bounded map drops.
      read.delete(conversationId);
      read.set(conversationId, { at: now(), session });
      for (const [id, last] of read) {
        if (read.size <= 1000 && now() - last.at < day) break;
        read.delete(id);
      }
    },
    jobUpdated(job: RelayJob) {
      if (job.method !== 'run') return;
      const request = z
        .object({ runId: z.string().uuid(), conversationId: z.string().uuid() })
        .safeParse(job.args.request);
      if (!request.success || request.data.runId !== job.id) return;
      const questions = job.events.flatMap((event) => {
        const value = event as { kind?: string; question?: unknown };
        const parsed = questionRequestSchema.safeParse(value?.question);
        return value?.kind === 'question' && parsed.success ? [parsed.data] : [];
      });
      const elicitations = job.events.flatMap((event) => {
        const value = event as { kind?: string; elicitation?: unknown };
        const parsed = elicitationReceiptSchema.safeParse(value?.elicitation);
        return value?.kind === 'elicitation' && parsed.success && parsed.data.runId === job.id
          ? [parsed.data]
          : [];
      });
      const attention =
        questions.length || elicitations.length
          ? attentionKeys({ blocks: [], questions, elicitations }).length > 0
          : job.events.some((event) => {
              const value = event as { kind?: string; tool?: unknown };
              const tool = toolActivitySchema.safeParse(value?.tool);
              return (
                value?.kind === 'tool' &&
                tool.success &&
                requestsAttention({ blocks: [{ type: 'activity', text: '', tool: tool.data }] })
              );
            });
      const kind = ['complete', 'error', 'cancelled'].includes(job.status)
        ? (job.status as 'complete' | 'error' | 'cancelled')
        : attention
          ? 'attention'
          : undefined;
      if (!kind) return;
      try {
        const next = pruned();
        const conversation = { title: conversationTitle(request.data.conversationId) ?? '' };
        const reply = jobReply(job, questions, elicitations);
        for (const key of kind === 'attention'
          ? questions.length || elicitations.length
            ? attentionKeys({ blocks: [], questions, elicitations })
            : ['attention']
          : ['terminal'])
          enqueue(
            next,
            {
              kind,
              conversationId: request.data.conversationId,
              tag: `studio-${job.id}`,
              ...chatNotification(kind, conversation, reply, key),
            },
            `${job.id}:${key}`,
          );
        save(next);
        void drain();
      } catch {
        unavailable = true;
      }
    },
    status(session: string) {
      const subscriber = pruned().subscribers.find((s) => s.session === session);
      return {
        publicKey: state.keys.publicKey,
        enabled: !!subscriber,
        unavailable,
        deliveryFailed: subscriber?.lastError ?? false,
        lastSent: subscriber?.lastSent,
      };
    },
    subscribe(session: string, actor: string, value: unknown, origin: string) {
      const subscription = subscriptionSchema.parse(value);
      const next = pruned();
      const existing = next.subscribers.find((s) => s.session === session);
      if (!existing && next.subscribers.length >= 1000)
        throw new Error('Notification device limit reached.');
      // Re-pairing the same browser replaces ownership without duplicating pushes.
      next.subscribers = next.subscribers.filter(
        (s) => s.session !== session && s.subscription.endpoint !== subscription.endpoint,
      );
      next.subscribers.push({
        id: existing?.id ?? randomUUID(),
        session,
        actor,
        subscription,
        subject: origin.startsWith('https:') ? origin : 'mailto:admin@localhost',
        lastError: false,
        testAt: existing?.testAt ?? 0,
      });
      save(next);
    },
    unsubscribe(session: string) {
      const next = pruned();
      const ids = new Set(next.subscribers.filter((s) => s.session === session).map((s) => s.id));
      next.subscribers = next.subscribers.filter((s) => s.session !== session);
      next.pending = next.pending.filter((p) => !ids.has(p.subscriber));
      save(next);
    },
    test(session: string) {
      const next = pruned();
      const subscriber = next.subscribers.find((s) => s.session === session);
      if (!subscriber) throw new Error('Enable notifications on this device first.');
      if (subscriber.testAt > now() - 30_000)
        throw new Error('Wait 30 seconds before sending another test.');
      next.subscribers = next.subscribers.map((s) =>
        s.id === subscriber.id ? { ...s, testAt: now() } : s,
      );
      enqueue(next, { kind: 'test', tag: 'studio-test' }, randomUUID(), subscriber.id);
      save(next);
      void drain();
    },
  };
}
