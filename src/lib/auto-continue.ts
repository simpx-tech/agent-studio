import { messageText, type Conversation, type Message, type ProviderId } from './domain';
import type { UsageSnapshot } from './usage';
import { replyUsageLimit, type AutoContinue } from './usage-limits';
import { exhaustedUntil } from './workflow-usage';

/**
 * A chat a usage limit stopped goes on by itself once the limit resets (docs/USAGE.md). The
 * computer that runs the chat plans when, from the account's usage reading and the provider's
 * own line, reads the account's usage again when the time comes, and sends `continueText` as the
 * chat's next message through the ordinary reply path. The plan is saved with the reply that
 * stopped, so every device shows it and any of them can cancel it.
 */

/** What the chat is sent once its limit resets. */
export const continueText = 'Continue where you left off.';

/** How long after a reset the chat goes on, so the provider counts the new window by then. */
const settle = 60_000;
/** A reset the line names a moment before the reply stopped had not been counted yet. */
const grace = 5 * 60_000;
/** How long a plan waits for a reading of the account's usage when nothing else names a reset. */
const readingWait = 10 * 60_000;

/** The reply a chat waits to go on after: its last message, stopped by a usage limit. */
export function limitedReply(conversation: Pick<Conversation, 'messages'>): Message | undefined {
  const last = conversation.messages.at(-1);
  return last?.role === 'assistant' && last.status === 'error' && replyUsageLimit(last)
    ? last
    : undefined;
}

/** The plan a reply that just stopped at a usage limit begins with, until its time is known. */
export const startedPlan = (now: number): AutoContinue => ({
  changedAt: new Date(now).toISOString(),
});

/** When a chat goes on by itself, as its plan says, while it waits to. */
export function waitingPlan(conversation: Pick<Conversation, 'messages'>) {
  const plan = limitedReply(conversation)?.autoContinue;
  return plan && !plan.off && plan.at ? plan.at : undefined;
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The date and time `instant` shows on the clocks of `timeZone`, this computer's by default. */
function wallClock(instant: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') % 24,
    minute: part('minute'),
    second: part('second'),
  };
}

/** The instant the clocks of `timeZone` show this date and time; days past a month's end roll over. */
function fromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone?: string,
) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wanted;
  // The zone's offset at a first guess, then again where that leads, which settles a guess that
  // fell on the other side of a change of offset.
  for (let i = 0; i < 2; i++) {
    const shown = wallClock(instant, timeZone);
    instant +=
      wanted -
      Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  }
  return instant;
}

function knownZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Claude Code names a reset in its own words: "resets 1:50pm (America/Sao_Paulo)" within a day,
// "resets Oct 7, 1pm (America/Sao_Paulo)" further on, with the year when it is another one.
const claudeReset =
  /\bresets (?:at )?(?:([a-z]{3}) (\d{1,2})(?:, (\d{4}))?,? (?:at )?)?(\d{1,2})(?::(\d{2}))?\s?([ap]m)\b(?:\s*\(([\w+\-/]+)\))?/i;
// Codex in the local time of the computer that runs it: "try again at 3:05 PM", or another day
// as "try again at Oct 25th, 2026 3:05 PM".
const codexReset =
  /\btry again at (?:([a-z]{3}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2})\s?([ap]m)\b/i;

/**
 * The reset the provider's line about a limit names, as the reply stopped at `stopped`: a time
 * of day is its next one, or one a moment before, which the provider had not counted yet.
 * Codex's times are read on this computer's clock, which runs its CLI.
 */
export function namedReset(text: string, provider: ProviderId, stopped: number): number | null {
  const match =
    provider === 'claude'
      ? claudeReset.exec(text)
      : provider === 'codex'
        ? codexReset.exec(text)
        : null;
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = match;
  const timeZone = provider === 'claude' ? zone : undefined;
  if (timeZone && !knownZone(timeZone)) return null;
  const twelve = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (twelve < 1 || twelve > 12 || minute > 59) return null;
  const hour = (twelve % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const today = wallClock(stopped, timeZone);
  if (!monthName) {
    const reset = fromWallClock(today.year, today.month, today.day, hour, minute, timeZone);
    return reset >= stopped - grace
      ? reset
      : fromWallClock(today.year, today.month, today.day + 1, hour, minute, timeZone);
  }
  const month = months.indexOf(monthName.toLowerCase()) + 1;
  const day = Number(dayText);
  if (!month || day < 1 || day > 31) return null;
  const year = yearText ? Number(yearText) : today.year;
  const reset = fromWallClock(year, month, day, hour, minute, timeZone);
  return yearText || reset >= stopped - grace
    ? reset
    : fromWallClock(year + 1, month, day, hour, minute, timeZone);
}

/** Whether a reply did anything before it stopped: reasoning, an answer, a comment or a call. */
function worked(reply: Message) {
  return (
    !!messageText(reply).trim() ||
    reply.blocks.some((block) => block.type !== 'activity' || !!block.tool || !!block.progress)
  );
}

/**
 * How many times in a row, at the chat's end, going on by itself came to nothing: the reply to
 * the message sent stopped at a limit again before doing anything. Each makes the next wait
 * twice as long past the reset, so a provider still refusing after it is not asked every minute.
 */
export function fruitlessContinues(messages: readonly Message[]): number {
  let count = 0;
  for (let index = messages.length - 1; index > 0; index -= 2) {
    const reply = messages[index];
    const sent = messages[index - 1];
    if (
      sent.role !== 'user' ||
      sent.sentBy !== 'limit' ||
      reply.role !== 'assistant' ||
      !replyUsageLimit(reply) ||
      worked(reply)
    )
      break;
    count++;
  }
  return count;
}

export type ContinueStep =
  /** Nothing to do now. */
  | { kind: 'wait' }
  /** Read the usage of the account the chat's next message goes to, then decide again. */
  | { kind: 'read' }
  /** Save this plan with the reply. */
  | { kind: 'plan'; plan: AutoContinue }
  /** Send the chat its next message. */
  | { kind: 'send' };

/**
 * What the computer running a chat does next for the reply a usage limit stopped, given the
 * latest usage reading of the account the chat's next message goes to (`snapshot`), and whether
 * that was just read for this (`read`). Until the plan has a time, it takes the later of the
 * reading's reset and the line's; a reading since the stop that names none, or none within ten
 * minutes, leaves nothing to wait for. Once the time comes, a reading since then that still
 * shows a limit used up moves the time to that limit's reset; otherwise the chat goes on.
 */
export function continueStep(
  conversation: Pick<Conversation, 'messages' | 'settings'>,
  snapshot: UsageSnapshot | undefined,
  now: number,
  read = false,
): ContinueStep {
  const reply = limitedReply(conversation);
  const plan = reply?.autoContinue;
  if (!reply || !plan || plan.off) return { kind: 'wait' };
  const chat = { provider: conversation.settings.provider, model: conversation.settings.model };
  const checked = (snapshot?.checkedAt ?? 0) * 1000;
  // A plan begins as its reply stops.
  const stopped = Date.parse(plan.changedAt ?? '') || Date.parse(reply.createdAt) || now;
  const changedAt = new Date(now).toISOString();
  const after = (reset: number): ContinueStep => {
    const delay = settle * 2 ** Math.min(fruitlessContinues(conversation.messages), 5);
    return {
      kind: 'plan',
      plan: { at: new Date(Math.max(reset, stopped) + delay).toISOString(), changedAt },
    };
  };
  const at = Date.parse(plan.at ?? '');
  if (!Number.isFinite(at)) {
    const reset = Math.max(
      exhaustedUntil(snapshot, chat, now) ?? -Infinity,
      namedReset(replyUsageLimit(reply)!.text, chat.provider, stopped) ?? -Infinity,
    );
    if (reset > -Infinity) return after(reset);
    if (checked >= stopped || now - stopped >= readingWait)
      return { kind: 'plan', plan: { off: true, changedAt } };
    return read ? { kind: 'wait' } : { kind: 'read' };
  }
  if (now < at) return { kind: 'wait' };
  if (checked < at && !read) return { kind: 'read' };
  const until = exhaustedUntil(snapshot, chat, now);
  return until ? after(until) : { kind: 'send' };
}

/** What a reply's card says of its chat going on: when, or that the time has come. */
export function continueLabel(at: string, now: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time) || time <= now) return 'Waiting to continue';
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(now).toDateString()) return `Continues at ${clock}`;
  // Within the week a weekday names the day without doubt; further on, the date does.
  const day =
    time - now < 6 * 86_400_000
      ? date.toLocaleDateString([], { weekday: 'long' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `Continues ${day} at ${clock}`;
}
