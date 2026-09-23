import { z } from 'zod';

// Workspace-wide text that Agent Studio appends to the system prompt of its Claude chats.
// An absent setting follows the default; an empty one adds nothing.
export const maxClaudeInstructions = 4000;
export const defaultClaudeInstructions =
  "When you need a command's result before your work is done (tests, builds, type checks), run it in the foreground with a long enough timeout (up to 10 minutes) instead of run_in_background, so your turn ends only when the work is finished. Use run_in_background only for processes meant to keep running: dev servers, watchers, or an app for me to try.";
export const claudeInstructionsSchema = z
  .string()
  .max(maxClaudeInstructions)
  .refine((text) => !text.includes('\0'), 'Instructions cannot contain null characters.');

export const claudeInstructions = (workspace: { claudeInstructions?: string }) =>
  workspace.claudeInstructions ?? defaultClaudeInstructions;

/** The stored form of edited text: matching the default keeps following it. */
export const storedClaudeInstructions = (text: string) =>
  text === defaultClaudeInstructions ? undefined : text;

/** Only a side that changed since the shared base replaces the other side's value. */
export function mergeClaudeInstructions(
  base: string | undefined,
  local: string | undefined,
  remote: string | undefined,
) {
  return local !== base ? local : remote;
}
