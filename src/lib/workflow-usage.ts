import type { ProviderId } from './domain';
import { resetTime, visibleLimits, type UsageSnapshot } from './usage';
import { quotaPace } from './pace';

/**
 * Usage as workflows read it (docs/WORKFLOWS.md): an account at a limit makes its agents wait
 * until the limit resets, and never stops a workflow. Limits come from the readings the chat's
 * usage bars show, and from Claude's own refusal over an account-wide limit.
 */

/** When an account at one of its limits can answer again, or null when it has room. */
export function exhaustedUntil(
  snapshot: UsageSnapshot | undefined,
  chat: { provider: ProviderId; model: string },
  now: number,
): number | null {
  if (!snapshot) return null;
  const limits = visibleLimits(snapshot, { ...chat, reasoning: '', instructions: '' });
  let until = 0;
  for (const window of limits) {
    if (window.usedPercent == null || window.usedPercent < 100) continue;
    const reset = resetTime(window.resetsAt);
    // A window that ended since its reading began again.
    if (reset != null && reset <= now) continue;
    until = Math.max(until, reset ?? now + 15 * 60_000);
  }
  const refused = snapshot.live?.limitStatus;
  if (
    refused?.status === 'rejected' &&
    refused.resetsAt != null &&
    refused.resetsAt * 1000 > now &&
    (refused.limitType === 'five_hour' || refused.limitType === 'seven_day')
  )
    until = Math.max(until, refused.resetsAt * 1000);
  return until > now ? until : null;
}

export type UsageReport = {
  limit: string;
  usedPercent: number | null;
  resetsAt: string | null;
  pace: string | null;
};
/** An account's limits as the orchestrator reads them: used share, reset and pace. */
export function usageReport(
  snapshot: UsageSnapshot | undefined,
  chat: { provider: ProviderId; model: string },
  now: number,
): UsageReport[] {
  return visibleLimits(snapshot, { ...chat, reasoning: '', instructions: '' }).map((window) => {
    const reset = resetTime(window.resetsAt);
    const pace = quotaPace(window, snapshot, now);
    return {
      limit: window.label,
      usedPercent: window.usedPercent,
      resetsAt: reset ? new Date(reset).toISOString() : null,
      pace: pace.state === 'unknown' ? null : pace.label,
    };
  });
}
