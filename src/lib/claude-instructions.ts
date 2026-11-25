import { z } from 'zod';

// Workspace-wide text that Agent Studio appends to the system prompt of its Claude chats.
// An absent setting follows the default; an empty one adds nothing.
export const defaultClaudeInstructions =
  "When you need a command's result before your work is done (tests, builds, type checks), run it in the foreground with a long enough timeout, so your turn ends only when the work is finished. Start a build, test suite or game run you expect to take more than a few minutes with run_in_background when other work does not need its result, go on with that work, and call await_background_tasks with its id before you finish. Never poll with sleep loops. Otherwise use run_in_background only for processes meant to keep running: dev servers, watchers, or an app for me to try.";
export const claudeInstructionsSchema = z
  .string()
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
