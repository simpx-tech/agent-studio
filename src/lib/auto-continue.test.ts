import { describe, expect, it } from 'vitest';
import {
  continueLabel,
  continueStep,
  continueText,
  fruitlessContinues,
  limitedReply,
  namedReset,
  startedPlan,
  waitingPlan,
} from './auto-continue';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Message,
} from './domain';
import { forkConversation } from './forks';
import { mergeShared, sharedWorkspace } from './sync';
import type { UsageSnapshot } from './usage';
import { autoContinueSchema, mergeAutoContinue, type AutoContinue } from './usage-limits';

const connectionId = crypto.randomUUID();
const settings = {
  ...settingsFor(initialWorkspace().preferences),
  provider: 'claude' as const,
  model: 'opus',
  connectionId,
};
const line = "You've hit your session limit · resets 1:50pm (America/Sao_Paulo)";
// 12:00 in São Paulo, three hours behind UTC all year.
const noon = Date.UTC(2026, 9, 22, 15, 0);
const minute = 60_000;

const user = (text: string, extra: Partial<Message> = {}): Message => ({
  id: crypto.randomUUID(),
  role: 'user',
  status: 'complete',
  createdAt: new Date(noon - 30 * minute).toISOString(),
  blocks: [{ type: 'markdown', text }],
  ...extra,
});
const limited = (autoContinue?: AutoContinue, extra: Partial<Message> = {}): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'error',
  error: line,
  createdAt: new Date(noon - 30 * minute).toISOString(),
  settings,
  blocks: [{ type: 'activity', text: 'Reading the map.', progress: { id: 'msg_1', revision: 1 } }],
  usageLimit: { revision: 1, text: line },
  ...(autoContinue ? { autoContinue } : {}),
  ...extra,
});
const chat = (...messages: Message[]): Conversation => ({
  id: crypto.randomUUID(),
  title: 'Map generator',
  createdAt: messages[0].createdAt,
  updatedAt: messages.at(-1)!.createdAt,
  settings,
  messages,
});
const reading = (checkedAt: number, used: number, resetsAt: number): UsageSnapshot => ({
  provider: 'claude',
  connectionId,
  checkedAt: Math.floor(checkedAt / 1000),
  context: null,
  detail: '',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour',
      usedPercent: used,
      resetsAt: Math.floor(resetsAt / 1000),
      windowMinutes: 300,
      model: null,
      bucket: 'claude',
    },
  ],
});
const iso = (time: number) => new Date(time).toISOString();
// 13:50 in São Paulo, when the line says the limit resets.
const reset = Date.UTC(2026, 9, 22, 16, 50);

describe('reset times named by the provider', () => {
  it('reads Claude Code’s reset in the time zone it names', () => {
    expect(namedReset(line, 'claude', noon)).toBe(reset);
    // A time of day already past is the next day's...
    const later = Date.UTC(2026, 9, 22, 17, 0);
    expect(namedReset(line, 'claude', later)).toBe(Date.UTC(2026, 9, 23, 16, 50));
    // ...unless it passed a moment before the stop, which the provider had not counted yet.
    expect(namedReset(line, 'claude', reset + 2 * minute)).toBe(reset);
    expect(
      namedReset("You've hit your session limit · resets 2pm (America/Sao_Paulo)", 'claude', noon),
    ).toBe(Date.UTC(2026, 9, 22, 17, 0));
    expect(
      namedReset(
        "You've hit your weekly limit · resets Oct 25, 3pm (America/Sao_Paulo) · progress saved",
        'claude',
        noon,
      ),
    ).toBe(Date.UTC(2026, 9, 25, 18, 0));
    expect(namedReset('Your usage resets Jan 3, 2027, 1:30am (UTC)', 'claude', noon)).toBe(
      Date.UTC(2027, 0, 3, 1, 30),
    );
    // A date of the next year names no year when it is less than a year away.
    expect(
      namedReset(
        'You’re out of usage credits · resets Jan 3, 1pm (UTC)',
        'claude',
        Date.UTC(2026, 11, 30),
      ),
    ).toBe(Date.UTC(2027, 0, 3, 13, 0));
    // A clock that moves forward in the night: 3:30 is the summer time's.
    expect(
      namedReset('resets Mar 8, 3:30am (America/New_York)', 'claude', Date.UTC(2026, 2, 1)),
    ).toBe(Date.UTC(2026, 2, 8, 7, 30));
    // Without a zone, this computer's clock.
    expect(
      namedReset(
        "You've hit your weekly limit · resets Oct 7, 1pm",
        'claude',
        new Date(2026, 9, 1).getTime(),
      ),
    ).toBe(new Date(2026, 9, 7, 13, 0).getTime());
  });

  it('reads Codex’s reset on this computer’s clock', () => {
    const morning = new Date(2026, 9, 22, 10, 0).getTime();
    expect(
      namedReset(
        'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.',
        'codex',
        morning,
      ),
    ).toBe(new Date(2026, 9, 22, 15, 5).getTime());
    expect(
      namedReset(
        "You've hit your usage limit. Try again at Oct 25th, 2026 3:05 PM.",
        'codex',
        morning,
      ),
    ).toBe(new Date(2026, 9, 25, 15, 5).getTime());
  });

  it('names nothing for lines without a reset, other providers and unknown zones', () => {
    for (const [text, provider] of [
      ["You've reached your Fable limit. Switch to another model to continue.", 'claude'],
      ['Your org is out of usage · contact your admin', 'claude'],
      ["You've hit your usage limit. Try again later.", 'codex'],
      [line, 'codex'],
      [line, 'gemini'],
      ["You've hit your session limit · resets 1:50pm (Moon/Tranquility)", 'claude'],
      ["You've hit your session limit · resets 13:50pm (UTC)", 'claude'],
    ] as const)
      expect(namedReset(text, provider, noon), text).toBeNull();
  });
});

describe('going on after a usage limit', () => {
  it('waits only on a chat whose last message is a reply a limit stopped, with a plan', () => {
    const planned = { at: iso(reset + minute), changedAt: iso(noon) };
    expect(limitedReply(chat(user('Go'), limited(planned)))).toBeDefined();
    expect(waitingPlan(chat(user('Go'), limited(planned)))).toBe(planned.at);
    for (const conversation of [
      chat(user('Go'), limited()),
      chat(user('Go'), limited({ ...planned, off: true })),
      chat(user('Go'), limited(planned), user('Something else')),
      chat(user('Go'), limited(planned, { status: 'complete' })),
      chat(user('Go'), limited(planned, { status: 'cancelled' })),
      chat(user('Go'), limited(planned, { usageLimit: undefined, error: 'Failed' })),
    ]) {
      expect(waitingPlan(conversation)).toBeUndefined();
      expect(continueStep(conversation, undefined, reset + 5 * minute)).toEqual({ kind: 'wait' });
    }
    // A plan still being made shows no time.
    expect(waitingPlan(chat(user('Go'), limited(startedPlan(noon))))).toBeUndefined();
  });

  it('plans a minute past the later of the line’s reset and the reading’s', () => {
    const conversation = chat(user('Go'), limited(startedPlan(noon)));
    expect(continueStep(conversation, undefined, noon + 1000)).toEqual({
      kind: 'plan',
      plan: { at: iso(reset + minute), changedAt: iso(noon + 1000) },
    });
    // The weekly limit is used up as well: the reading names its later reset.
    const weekly = Date.UTC(2026, 9, 25, 18, 0);
    expect(
      continueStep(conversation, reading(noon - minute, 100, weekly), noon + 1000),
    ).toMatchObject({ kind: 'plan', plan: { at: iso(weekly + minute) } });
    // A reading from before the limit, with room left, does not move the line's reset earlier.
    expect(
      continueStep(conversation, reading(noon - 9 * minute, 97, reset), noon + 1000),
    ).toMatchObject({ kind: 'plan', plan: { at: iso(reset + minute) } });
  });

  it('asks for a reading when nothing names a reset, and gives up once none can', () => {
    const fable = "You've reached your Fable limit. Switch to another model to continue.";
    const conversation = chat(
      user('Go'),
      limited(startedPlan(noon), { usageLimit: { revision: 1, text: fable } }),
    );
    expect(continueStep(conversation, reading(noon - minute, 40, reset), noon + 1000)).toEqual({
      kind: 'read',
    });
    // A reading under way: the next look decides.
    expect(
      continueStep(conversation, reading(noon - minute, 40, reset), noon + 1000, true),
    ).toEqual({ kind: 'wait' });
    // A reading since the stop that shows every limit with room names nothing to wait for.
    expect(continueStep(conversation, reading(noon + 5000, 40, reset), noon + 6000)).toEqual({
      kind: 'plan',
      plan: { off: true, changedAt: iso(noon + 6000) },
    });
    // Nor does a reading that never comes.
    expect(continueStep(conversation, undefined, noon + 10 * minute)).toMatchObject({
      kind: 'plan',
      plan: { off: true },
    });
    // A used-up limit in that reading names its reset.
    expect(continueStep(conversation, reading(noon + 5000, 100, reset), noon + 6000)).toMatchObject(
      {
        kind: 'plan',
        plan: { at: iso(reset + minute) },
      },
    );
  });

  it('reads the usage again when the time comes, and goes on only with room', () => {
    const at = reset + minute;
    const conversation = chat(user('Go'), limited({ at: iso(at), changedAt: iso(noon) }));
    expect(continueStep(conversation, undefined, at - 1000)).toEqual({ kind: 'wait' });
    // An older reading cannot tell.
    expect(continueStep(conversation, reading(noon, 100, reset), at + 1000)).toEqual({
      kind: 'read',
    });
    // The window that was used up began again.
    expect(
      continueStep(conversation, reading(at + 500, 0, reset + 300 * minute), at + 1000),
    ).toEqual({ kind: 'send' });
    // Still used up: the plan moves to the reset that reading names.
    const weekly = Date.UTC(2026, 9, 25, 18, 0);
    expect(continueStep(conversation, reading(at + 500, 100, weekly), at + 1000)).toEqual({
      kind: 'plan',
      plan: { at: iso(weekly + minute), changedAt: iso(at + 1000) },
    });
    // A reading that failed leaves it to the provider.
    expect(continueStep(conversation, reading(noon, 100, reset), at + 1000, true)).toEqual({
      kind: 'send',
    });
    // Without a reading, the old window's reset passed and Claude's refusal named it.
    const refused: UsageSnapshot = {
      ...reading(noon, 50, reset),
      live: {
        accountChanged: '',
        authMode: null,
        planType: null,
        limitStatus: {
          status: 'rejected',
          limitType: 'five_hour',
          resetsAt: Math.floor(reset / 1000),
          usingOverage: false,
          checkedAt: Math.floor(noon / 1000),
        },
      },
    };
    expect(continueStep(conversation, refused, at + 1000, true)).toEqual({ kind: 'send' });
  });

  it('waits twice as long past the reset each time going on came to nothing', () => {
    const first = limited({ at: iso(reset + minute), changedAt: iso(noon) });
    const nothing = (plan?: AutoContinue) =>
      limited(plan, { blocks: [{ type: 'activity', text: 'Connected' }] });
    const sent = () => user(continueText, { sentBy: 'limit' });
    expect(fruitlessContinues([user('Go'), first])).toBe(0);
    const again = [user('Go'), first, sent(), nothing(startedPlan(reset + 2 * minute))];
    expect(fruitlessContinues(again)).toBe(1);
    expect(continueStep(chat(...again), undefined, reset + 2 * minute + 1000)).toMatchObject({
      kind: 'plan',
      plan: { at: iso(reset + 2 * minute + 2 * minute) },
    });
    expect(fruitlessContinues([...again.slice(0, 3), nothing(), sent(), nothing()])).toBe(2);
    // A reply that did something before the next limit starts the count again.
    const worked = limited(undefined, {
      blocks: [{ type: 'markdown', text: 'Half of the map is done.' }],
    });
    expect(fruitlessContinues([user('Go'), first, sent(), worked])).toBe(0);
    // So does a message of the user's own.
    expect(fruitlessContinues([user('Go'), first, user('Go on'), nothing()])).toBe(0);
  });

  it('says when the chat goes on, or that the time has come', () => {
    // Thursday noon, on this computer's clock and in its language.
    const now = new Date(2026, 9, 22, 12, 0).getTime();
    const clock = (date: Date) =>
      date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const today = new Date(2026, 9, 22, 13, 51);
    expect(continueLabel(iso(today.getTime()), now)).toBe(`Continues at ${clock(today)}`);
    const saturday = new Date(2026, 9, 24, 9, 0);
    expect(continueLabel(iso(saturday.getTime()), now)).toBe(
      `Continues ${saturday.toLocaleDateString([], { weekday: 'long' })} at ${clock(saturday)}`,
    );
    const later = new Date(2026, 10, 2, 9, 0);
    expect(continueLabel(iso(later.getTime()), now)).toBe(
      `Continues ${later.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${clock(later)}`,
    );
    expect(continueLabel(iso(now - 1000), now)).toBe('Waiting to continue');
    expect(continueLabel('not a time', now)).toBe('Waiting to continue');
  });
});

describe('the plan as saved and synced', () => {
  it('merges with a cancel winning, then the later change', () => {
    const planned = { at: iso(reset), changedAt: iso(noon) };
    const moved = { at: iso(reset + 9 * minute), changedAt: iso(noon + minute) };
    const cancelled = { ...planned, off: true, changedAt: iso(noon - minute) };
    expect(mergeAutoContinue(planned, moved)).toBe(moved);
    expect(mergeAutoContinue(moved, planned)).toBe(moved);
    expect(mergeAutoContinue(moved, cancelled)).toBe(cancelled);
    expect(mergeAutoContinue(cancelled, moved)).toBe(cancelled);
    expect(mergeAutoContinue(undefined, planned)).toBe(planned);
    expect(mergeAutoContinue(planned, undefined)).toBe(planned);
  });

  it('keeps whatever a later release adds to it', () => {
    expect(autoContinueSchema.safeParse({ off: false, reason: 'later', at: 'soon' }).success).toBe(
      true,
    );
    const workspace = initialWorkspace();
    workspace.conversations = [
      chat(
        user('Go'),
        limited({ at: iso(reset + minute), changedAt: iso(noon) }),
        user(continueText, { sentBy: 'limit' }),
      ),
    ];
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.conversations[0].messages[1].autoContinue).toEqual({
      at: iso(reset + minute),
      changedAt: iso(noon),
    });
    expect(restored.conversations[0].messages[2].sentBy).toBe('limit');
    // The model reads the message sent as the user's next one.
    expect(historyFor(restored.conversations[0]).map((m) => m.text)).toEqual(['Go', continueText]);
  });

  it('survives relays that drop it and merges a cancel made elsewhere', () => {
    const workspace = initialWorkspace();
    const planned = { at: iso(reset + minute), changedAt: iso(noon) };
    workspace.conversations = [chat(user('Go'), limited(planned))];
    const local = sharedWorkspace(workspace);
    // A relay from before the plan stores the reply without it.
    const stripped = structuredClone(local);
    delete stripped.conversations[0].messages[1].autoContinue;
    expect(mergeShared(local, local, stripped).conversations[0].messages[1].autoContinue).toEqual(
      planned,
    );
    // The computer moved the time while the phone cancelled.
    const computer = structuredClone(local);
    computer.conversations[0].messages[1].autoContinue = {
      at: iso(reset + 9 * minute),
      changedAt: iso(noon + 2 * minute),
    };
    const phone = structuredClone(local);
    phone.conversations[0].messages[1].autoContinue = {
      ...planned,
      off: true,
      changedAt: iso(noon + minute),
    };
    for (const [left, right] of [
      [computer, phone],
      [phone, computer],
    ]) {
      const merged = mergeShared(local, left, right);
      expect(merged.conversations).toHaveLength(1);
      expect(merged.conversations[0].messages[1].autoContinue?.off).toBe(true);
    }
  });

  it('never goes on in a fork or a conflict copy', () => {
    const planned = { at: iso(reset + minute), changedAt: iso(noon) };
    const source = chat(user('Go'), limited(planned));
    expect(forkConversation(source).messages[1].autoContinue).toBeUndefined();
    expect(source.messages[1].autoContinue).toEqual(planned);
    const workspace = initialWorkspace();
    workspace.conversations = [source];
    const base = sharedWorkspace(workspace);
    const here = structuredClone(base);
    here.conversations[0].messages.push(user('Written here'));
    const there = structuredClone(base);
    there.conversations[0].messages.push(user('Written there'));
    const merged = mergeShared(base, here, there);
    expect(merged.conversations.map((c) => c.title)).toEqual([
      'Map generator',
      'Map generator (conflict copy)',
    ]);
    expect(merged.conversations[0].messages[1].autoContinue).toEqual(planned);
    expect(merged.conversations[1].messages[1].autoContinue).toBeUndefined();
  });
});
