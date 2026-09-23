import { describe, expect, it } from 'vitest';
import { initialWorkspace, restoreWorkspace, settingsFor, type Message } from './domain';
import {
  replyAccountChanged,
  replyModelName,
  replySettingsChanged,
  replySwitches,
  selectedModelName,
  replyTimeTotals,
  formatReplyTime,
} from './replies';

const reply = (model: string, reasoning: 'low' | 'high' = 'low'): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  blocks: [],
  status: 'complete',
  createdAt: '',
  settings: { ...settingsFor(initialWorkspace().preferences), model, reasoning },
});

describe('reply identities and model switches', () => {
  it('totals recorded assistant time through each reply across model changes, stops, and failures', () => {
    const first = { ...reply('sonnet'), durationMs: 1250 };
    const stopped = { ...reply('sonnet'), status: 'cancelled' as const, durationMs: 61250 };
    const failed = { ...reply('gpt-6-astra'), status: 'error' as const, durationMs: 1000 };
    const running: Message = { ...reply('gpt-6-astra'), status: 'running', durationMs: 9000 };
    const messages = [
      first,
      { ...reply(''), role: 'user' as const, durationMs: 999999 },
      stopped,
      failed,
      running,
    ];
    expect([...replyTimeTotals(messages)]).toEqual([
      [first.id, { durationMs: 1250, missing: 0 }],
      [stopped.id, { durationMs: 62500, missing: 0 }],
      [failed.id, { durationMs: 63500, missing: 0 }],
    ]);
    running.durationMs = 500;
    running.status = 'complete';
    expect(replyTimeTotals(messages).get(running.id)).toEqual({ durationMs: 64000, missing: 0 });
    expect(replyTimeTotals([first]).get(first.id)?.durationMs).toBe(1250);
  });
  it('distinguishes unknown timing from a recorded zero without inventing durations', () => {
    const missing = reply('');
    const zero = { ...reply(''), durationMs: 0 };
    const invalid = { ...reply(''), durationMs: -12 };
    const timed = { ...reply(''), durationMs: 12000 };
    const totals = replyTimeTotals([missing, zero, invalid, timed]);
    expect(totals.get(missing.id)).toEqual({ durationMs: null, missing: 1 });
    expect(totals.get(zero.id)).toEqual({ durationMs: 0, missing: 1 });
    expect(totals.get(timed.id)).toEqual({ durationMs: 12000, missing: 2 });
    expect(replyTimeTotals([]).size).toBe(0);
  });
  it('keeps tenths under a minute and whole seconds with minutes and hours', () => {
    expect(formatReplyTime(0)).toBe('0.0s');
    expect(formatReplyTime(1250)).toBe('1.3s');
    expect(formatReplyTime(59949)).toBe('59.9s');
    expect(formatReplyTime(59950)).toBe('1m 0s');
    expect(formatReplyTime(62500)).toBe('1m 3s');
    expect(formatReplyTime(1710800)).toBe('28m 31s');
    expect(formatReplyTime(3599499)).toBe('59m 59s');
    expect(formatReplyTime(3599500)).toBe('1h 0m 0s');
    expect(formatReplyTime(4052000)).toBe('1h 7m 32s');
  });
  it('captures a resolved CLI default name without relabeling old replies', () => {
    const message = reply('');
    message.modelName = selectedModelName('', [
      { id: '', name: 'CLI default · GPT-6-Astra', reasoningLevels: [], defaultReasoning: '' },
    ]);
    expect(replyModelName(message)).toBe('GPT-6-Astra');
    expect(replyModelName(reply('gpt-5.6-sol'))).toBe('GPT-5.6-Sol');
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      settings: reply('gpt-5.6-sol').settings!,
      title: 'Later model',
      createdAt: '',
      updatedAt: '',
      messages: [message],
    });
    expect(replyModelName(restoreWorkspace(workspace).conversations[0].messages[0])).toBe(
      'GPT-6-Astra',
    );
  });
  it('prefers a reported model over an alias and keeps unknown defaults explicit', () => {
    const message = reply('sonnet');
    message.modelName = 'Sonnet (latest)';
    message.usage = { model: 'claude-sonnet-4-5' };
    expect(replyModelName(message)).toBe('Claude-Sonnet-4-5');
    expect(replyModelName(reply(''))).toBe('CLI default');
  });
  it('announces model and reasoning changes only on the affected assistant reply', () => {
    const first = reply('gpt-6-astra');
    const second = reply('gpt-5.6-sol', 'high');
    const third = reply('gpt-5.6-sol');
    const fourth = reply('gpt-5.6-sol');
    const notices = replySwitches([first, { ...reply(''), role: 'user' }, second, third, fourth]);
    expect([...notices]).toEqual([
      [second.id, 'Switched to GPT-5.6-Sol · High reasoning'],
      [third.id, 'Switched to Low reasoning'],
    ]);
  });
  it('does not invent a switch across a missing historical snapshot or an instruction edit', () => {
    const old = reply('');
    delete old.settings;
    const first = reply('gpt-6-astra');
    const second = reply('gpt-6-astra');
    second.settings!.instructions = 'Changed instructions';
    expect(replySwitches([old, first, second]).size).toBe(0);
  });
  it('announces account switches by the current name, then the recorded label', () => {
    const first = reply('sonnet');
    first.settings!.connectionId = crypto.randomUUID();
    const second = reply('sonnet');
    second.settings!.connectionId = crypto.randomUUID();
    second.executionLabel = 'Work Claude · Desktop / Windows';
    const third = reply('opus', 'high');
    third.settings!.connectionId = second.settings!.connectionId;
    const legacy = reply('opus', 'high');
    const notices = replySwitches([first, second, third, legacy], (id) =>
      id === second.settings!.connectionId ? 'Renamed Claude' : undefined,
    );
    expect([...notices]).toEqual([
      [second.id, 'Switched to Renamed Claude account'],
      [third.id, 'Switched to Opus · High reasoning'],
    ]);
    expect(replySwitches([first, second]).get(second.id)).toBe('Switched to Work Claude account');
    delete second.executionLabel;
    expect(replySwitches([first, second]).get(second.id)).toBe('Switched to another account');
    const both = reply('opus');
    both.settings!.connectionId = crypto.randomUUID();
    expect(replySwitches([second, both]).get(both.id)).toBe(
      'Switched to another account · Opus',
    );
    expect(replyAccountChanged(first.settings!, second.settings!)).toBe(true);
    expect(replyAccountChanged(third.settings!, legacy.settings!)).toBe(false);
    expect(replySettingsChanged(third.settings!, legacy.settings!)).toBe(false);
  });
});
