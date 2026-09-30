import { describe, expect, it } from 'vitest';
import { applyRunEvent, retainRunEvent, savesAtOnce } from './activity';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Conversation,
  type Message,
  type RunEvent,
} from './domain';
import { replyModelMismatch, replyModelName } from './replies';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';
import { automaticModel } from './models';
import { contextFor } from './usage';
import {
  claudeLimitLine,
  latestUsageLimit,
  limitResets,
  replyUsageLimit,
  savedLimitComment,
  usageLimitSchema,
} from './usage-limits';

const line = "You've hit your session limit · resets 1:50pm (America/Sao_Paulo)";
const reply = (extra: Partial<Message> = {}): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'error',
  error: line,
  blocks: [],
  createdAt: '2026-09-30',
  settings: { ...settingsFor(initialWorkspace().preferences), provider: 'claude', model: 'opus' },
  modelName: 'Opus 5.5',
  ...extra,
});
const chat = (messages: Message[]): Conversation => ({
  id: crypto.randomUUID(),
  title: 'Limits',
  createdAt: '2026-09-30',
  updatedAt: '2026-09-30',
  settings: messages[0]?.settings ?? settingsFor(initialWorkspace().preferences),
  messages,
});
// A reply saved before 2026-09-30: Claude Code's line was a progress comment of its own message.
const savedReply = () =>
  reply({
    usage: { model: '<synthetic>', contextInput: 0, input: 5000, output: 20 },
    blocks: [
      { type: 'activity', text: 'Reading the generator.', progress: { id: 'msg_1', revision: 1 } },
      { type: 'activity', text: line, progress: { id: 'b5b9d6d0', revision: 1 } },
      { type: 'activity', text: 'File Undo unavailable: A file no longer matches' },
    ],
  });

describe('usage limits', () => {
  it('recognizes Claude Code’s limit lines, not its warnings or other failures', () => {
    for (const text of [
      line,
      'You’ve hit your weekly limit · resets Oct 7, 1pm',
      "You've reached your Fable limit. Switch to another model to continue.",
      "You're out of usage credits. Run /usage-credits to keep using Opus 5.5.",
      'Fable 5.1 requires usage credits. Switch to another model to continue.',
    ])
      expect(claudeLimitLine(text), text).toBe(true);
    for (const text of [
      'API Error: Request rejected (429) · this may be a temporary capacity issue.',
      "You've used 90% of your session limit",
      'Now using extra usage',
      'The generator now hits your limits.',
    ])
      expect(claudeLimitLine(text), text).toBe(false);
  });

  it('knows which limits name a time they reset', () => {
    const limit = (text: string) => ({ revision: 1, text });
    expect(limitResets(limit(line))).toBe(true);
    expect(
      limitResets(limit('You’ve hit your usage limit. Upgrade to Pro, or try again at 3:05 PM.')),
    ).toBe(true);
    expect(
      limitResets(limit("You've reached your Fable limit. Switch to another model to continue.")),
    ).toBe(false);
    expect(limitResets(limit("You're out of usage credits. Run /usage-credits."))).toBe(false);
  });

  it('keeps the latest bounded record and saves it at once, apart from other replies', () => {
    expect(usageLimitSchema.safeParse({ revision: 1, text: '' }).success).toBe(false);
    expect(usageLimitSchema.safeParse({ revision: 1, text: 'x'.repeat(1001) }).success).toBe(false);
    const first = { revision: 1, text: line };
    const second = { revision: 2, text: "You've hit your weekly limit · resets Oct 7, 1pm" };
    expect(latestUsageLimit(first, second)).toBe(second);
    expect(latestUsageLimit(second, first)).toBe(second);
    expect(latestUsageLimit(undefined, first)).toBe(first);
    const m = reply({ status: 'running', error: undefined });
    applyRunEvent(m, { kind: 'usagelimit', usageLimit: second });
    applyRunEvent(m, { kind: 'usagelimit', usageLimit: first });
    applyRunEvent(m, { kind: 'usagelimit', usageLimit: { revision: 3, text: '' } });
    expect(m.usageLimit).toEqual(second);
    expect(m.blocks).toEqual([]);
    const user: Message = { ...reply(), role: 'user', blocks: [] };
    applyRunEvent(user, { kind: 'usagelimit', usageLimit: first });
    expect(user.usageLimit).toBeUndefined();
    expect(savesAtOnce({ kind: 'usagelimit' })).toBe(true);
    const events: RunEvent[] = [];
    retainRunEvent(events, { kind: 'usagelimit', usageLimit: first });
    retainRunEvent(events, { kind: 'usagelimit', usageLimit: second });
    expect(events).toEqual([{ kind: 'usagelimit', usageLimit: second }]);
  });

  it('marks replies stopped at a limit, including ones saved before the record', () => {
    const limited = reply({ usageLimit: { revision: 1, text: line } });
    expect(replyUsageLimit(limited)).toEqual({ revision: 1, text: line });
    expect(replyUsageLimit({ ...limited, status: 'running' })).toEqual(limited.usageLimit);
    // A reply that went on to complete is not stopped by it.
    expect(replyUsageLimit({ ...limited, status: 'complete' })).toBeUndefined();
    const saved = savedReply();
    expect(replyUsageLimit(saved)).toEqual({ revision: 0, text: line });
    expect(saved.blocks.filter(savedLimitComment)).toEqual([saved.blocks[1]]);
    // Without Claude Code's own model, a progress comment is the agent's words.
    expect(replyUsageLimit({ ...saved, usage: { model: 'claude-opus-5-5' } })).toBeUndefined();
    expect(replyUsageLimit({ ...saved, usage: undefined })).toBeUndefined();
  });

  it('never names the reply’s model or context after Claude Code’s own message', () => {
    const saved = savedReply();
    expect(replyModelName(saved)).toBe('Opus 5.5');
    expect(replyModelMismatch(saved)).toBeUndefined();
    const conversation = chat([saved]);
    const context = contextFor(conversation, conversation.settings, '', automaticModel);
    expect(context.reported).toBeNull();
    expect(context.unavailableReason).toBe(
      'This reply did not include a request-level context reading.',
    );
  });

  it('survives save, export and relays that drop it, and is never replayed', () => {
    const m = reply({ usageLimit: { revision: 2, text: line } });
    const conversation = chat([
      { ...reply(), role: 'user', status: 'complete', blocks: [{ type: 'markdown', text: 'Go' }] },
      m,
    ]);
    const workspace = initialWorkspace();
    workspace.conversations = [conversation];
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.conversations[0].messages[1].usageLimit).toEqual(m.usageLimit);
    expect(JSON.stringify(historyFor(conversation))).not.toContain('hit your');
    const local = sharedWorkspace(workspace);
    // A relay from before the record stores the reply without it.
    const stripped = structuredClone(local);
    delete stripped.conversations[0].messages[1].usageLimit;
    expect(mergeShared(local, local, stripped).conversations[0].messages[1].usageLimit).toEqual(
      m.usageLimit,
    );
    // Two copies of the same run keep the later record.
    const older = structuredClone(local);
    older.conversations[0].messages[1].usageLimit = { revision: 1, text: 'You’ve hit your limit' };
    older.conversations[0].messages[1].status = 'running';
    for (const [left, right] of [
      [local, older],
      [older, local],
    ])
      expect(
        mergeShared(emptyShared(), left, right).conversations[0].messages[1].usageLimit,
      ).toEqual(m.usageLimit);
  });
});
