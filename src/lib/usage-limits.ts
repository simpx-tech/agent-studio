import { z } from 'zod';
import type { ContentBlock, Message } from './domain';

/**
 * A usage limit that stopped a reply, in the provider's own words: Claude Code's line, such as
 * "You've hit your session limit · resets 1:50pm (America/Sao_Paulo)", or the message of a Codex
 * turn that failed at the account's limit. Neither is the model's text.
 */
export const usageLimitSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1).max(1000),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

/** The later of two records of a reply's limit. */
export function latestUsageLimit(left?: UsageLimit, right?: UsageLimit): UsageLimit | undefined {
  if (!left || !right) return left ?? right;
  return right.revision > left.revision ? right : left;
}

/** Claude Code's model name for the messages it writes itself: they ran no request. */
export const syntheticModel = '<synthetic>';

// The first words of Claude Code's lines about a limit it reached, as in
// src-tauri/src/protocol/usage_limit.rs. Its warnings and notices are not here.
const claudeLines = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "You're out of extra usage",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  "Your seat type doesn't include extra usage",
  'Your usage allocation has been disabled',
  "Your group's usage limit is set to",
];

export function claudeLimitLine(text: string): boolean {
  const line = text.trim().replaceAll('’', "'");
  return (
    claudeLines.some((start) => line.startsWith(start)) ||
    (line.startsWith('Fable ') && line.slice(0, 64).includes(' requires usage credits.'))
  );
}

/**
 * A progress comment holding Claude Code's line about a limit. Replies saved before 2026-09-30
 * recorded the line that way, from a message of Claude Code's own.
 */
export const savedLimitComment = (block: ContentBlock) =>
  block.type === 'activity' && !!block.progress && claudeLimitLine(block.text);

/**
 * The usage limit that stopped a reply that has not completed. Replies saved before 2026-09-30
 * name none, but reported the model of Claude Code's message about it, `<synthetic>`, and kept
 * its line as their last such progress comment.
 */
export function replyUsageLimit(
  message: Pick<Message, 'role' | 'status' | 'usageLimit' | 'usage' | 'blocks'>,
): UsageLimit | undefined {
  if (message.role !== 'assistant' || message.status === 'complete') return undefined;
  if (message.usageLimit) return message.usageLimit;
  if (message.usage?.model !== syntheticModel) return undefined;
  const comment = message.blocks.findLast(savedLimitComment);
  return comment ? { revision: 0, text: comment.text.trim() } : undefined;
}
