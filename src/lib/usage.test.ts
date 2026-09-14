import { describe, expect, it } from 'vitest';
import { initialWorkspace, settingsFor, restoreWorkspace, type Conversation } from './domain';
import {
  contextFor,
  creditReading,
  accountLimits,
  estimatePromptTokens,
  isStale,
  recordedUsage,
  resetLabel,
  resetTime,
  snapshotFor,
  visibleLimits,
  type UsageSnapshot,
} from './usage';
import { automaticModel } from './models';

const settings = settingsFor(initialWorkspace().preferences);
const snapshot: UsageSnapshot = {
  provider: 'claude',
  checkedAt: 1000,
  context: null,
  detail: 'Fixture',
  windows: [
    {
      id: '5h',
      label: '5-hour',
      usedPercent: 0,
      resetsAt: 2000,
      windowMinutes: 300,
      model: null,
      bucket: 'claude',
    },
    {
      id: 'week',
      label: 'Weekly',
      usedPercent: 31,
      resetsAt: 9000,
      windowMinutes: 10080,
      model: null,
      bucket: 'claude',
    },
    {
      id: 'fable',
      label: 'Fable weekly',
      usedPercent: 62,
      resetsAt: 9000,
      windowMinutes: 10080,
      model: 'fable',
      bucket: 'claude',
    },
  ],
};
describe('usage and context semantics', () => {
  it('keeps credits separate from quotas, resets, money and other accounts', () => {
    const codex: UsageSnapshot = {
      ...snapshot,
      provider: 'codex',
      connectionId: 'one',
      credits: { kind: 'codex', balance: 0, hasCredits: false, unlimited: false, resetCredits: 2 },
    };
    expect(creditReading('codex', codex)?.value).toBe('0.00 credits');
    expect(creditReading('codex', codex)?.rows[0].value).toBe('2');
    expect(creditReading('claude', codex)?.value).toBe('Not reported');
    expect(creditReading('gemini', codex)).toBeNull();
    expect(creditReading('codex')?.value).toBe('Not reported');
    expect(
      snapshotFor({ 'codex::one': codex }, { provider: 'codex', model: '', connectionId: 'two' }),
    ).toBeUndefined();
    expect(
      creditReading('codex', {
        ...codex,
        credits: {
          kind: 'codex',
          balance: null,
          hasCredits: true,
          unlimited: false,
          resetCredits: null,
        },
      })?.value,
    ).toBe('Available');
    expect(
      creditReading('codex', {
        ...codex,
        credits: {
          kind: 'codex',
          balance: null,
          hasCredits: true,
          unlimited: true,
          resetCredits: null,
        },
      })?.value,
    ).toBe('Unlimited');
    const claude: UsageSnapshot = {
      ...snapshot,
      credits: {
        kind: 'claude',
        used: 12.5,
        limit: 100,
        currency: 'USD',
        usedPercent: 12.5,
        enabled: true,
      },
    };
    const reading = creditReading('claude', claude)!;
    expect(reading.value).toMatch(/USD\s12.50 spent/);
    expect(reading.rows.find((r) => r.label === 'Remaining under cap')?.value).toMatch(
      /USD\s87.50/,
    );
    expect(reading.detail).toContain('not a credit balance');
    if (claude.credits?.kind === 'claude') {
      claude.credits.enabled = false;
      claude.credits.limit = null;
    }
    expect(creditReading('claude', claude)?.value).toBe('Disabled');
    expect(
      creditReading('claude', claude)?.rows.find((r) => r.label === 'Remaining under cap'),
    ).toBeUndefined();
  });
  it('keeps account windows and model scopes separate, with missing limits distinct from zero', () => {
    const windows = accountLimits(snapshot, 'claude');
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 0],
      ['Weekly', 31],
      ['Fable weekly', 62],
    ]);
    expect(accountLimits(undefined, 'codex').map((w) => w.usedPercent)).toEqual([null]);
    const spark = {
      ...snapshot.windows[0],
      id: 'spark',
      bucket: 'spark',
      model: 'Spark',
      usedPercent: 99,
    };
    const codex = {
      ...snapshot,
      provider: 'codex',
      windows: [{ ...snapshot.windows[0], bucket: 'codex' }, spark],
    };
    expect(accountLimits(codex, 'codex').map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 0],
      ['Weekly', null],
      ['Spark · 5-hour', 99],
    ]);
    const scoped = { ...snapshot, connectionId: 'first-account' };
    expect(
      snapshotFor(
        { 'claude::first-account': scoped },
        {
          provider: 'claude',
          model: '',
          connectionId: 'second-account',
        },
      ),
    ).toBeUndefined();
  });
  it('shares newer account quotas while keeping context capacity tied to the selected model', () => {
    const fable = { ...settings, provider: 'claude' as const, model: 'fable' };
    const fableSnapshot = {
      ...snapshot,
      context: { model: 'claude-fable-5-1', tokens: 1e6, source: 'CLI' },
    };
    const sonnetSnapshot = {
      ...snapshot,
      checkedAt: 1100,
      windows: snapshot.windows.map((w) => ({ ...w, usedPercent: 70 })),
      context: { model: 'claude-sonnet', tokens: 200000, source: 'CLI' },
    };
    const snapshots = { 'claude:fable': fableSnapshot, 'claude:sonnet': sonnetSnapshot };
    const selected = snapshotFor(snapshots, fable);
    expect(selected?.windows[0].usedPercent).toBe(70);
    expect(selected?.context?.tokens).toBe(1e6);
    expect(snapshotFor(snapshots, { ...fable, model: 'haiku' })?.context).toBeNull();
    expect(snapshotFor(snapshots, { ...fable, provider: 'gemini' })).toBeUndefined();
  });
  it('shows Fable only for Fable, including the resolved CLI default', () => {
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'claude', model: 'sonnet' }),
    ).toHaveLength(2);
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'claude', model: 'fable' })[2].usedPercent,
    ).toBe(62);
    expect(
      visibleLimits(
        { ...snapshot, context: { model: 'claude-fable-5-1', tokens: 1e6, source: 'CLI' } },
        { ...settings, provider: 'claude', model: '' },
      ),
    ).toHaveLength(3);
    expect(
      visibleLimits(snapshot, { ...settings, provider: 'gemini', model: 'fable' }),
    ).toHaveLength(2);
  });
  it('does not invent zero usage or attach another Codex bucket to the selected model', () => {
    const codex = {
      ...snapshot,
      provider: 'codex',
      windows: [
        { ...snapshot.windows[1], bucket: 'codex' },
        { ...snapshot.windows[0], bucket: 'spark', model: 'GPT-5.3-Codex-Spark' },
      ],
    };
    expect(visibleLimits(codex, settings).map((w) => w.windowMinutes)).toEqual([10080]);
    const missingShortWindow = {
      ...codex,
      windows: [...codex.windows, { ...snapshot.windows[0], usedPercent: null, bucket: 'codex' }],
    };
    expect(accountLimits(missingShortWindow, 'codex').map((w) => [w.label, w.usedPercent])).toEqual(
      [
        ['Weekly', 31],
        ['GPT-5.3-Codex-Spark · 5-hour', 0],
      ],
    );
    expect(visibleLimits(codex, { ...settings, model: 'gpt-5.3-codex-spark' })[0].usedPercent).toBe(
      0,
    );
    expect(visibleLimits(undefined, settings).every((w) => w.usedPercent == null)).toBe(true);
  });
  it('normalizes reset times and marks old or elapsed readings as stale', () => {
    expect(resetTime('2026-09-08T12:00:00Z')).toBe(Date.parse('2026-09-08T12:00:00Z'));
    expect(resetTime(1000)).toBe(1e6);
    expect(resetTime('invalid')).toBeNull();
    expect(resetLabel(null, 1e6)).toBe('Reset time not reported');
    expect(resetLabel(1000, 1e6)).toContain('Reset due');
    expect(isStale(snapshot, snapshot.windows[0], 1100000)).toBe(false);
    expect(isStale(snapshot, snapshot.windows[0], 2000000)).toBe(true);
  });
  it('estimates replayed context rather than summing billing, and accounts for drafts and switches', () => {
    const user = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      blocks: [{ type: 'markdown' as const, text: 'Plan a garden' }],
      createdAt: '',
      status: 'complete' as const,
    };
    const promptTokensEstimate = estimatePromptTokens(settings, [
      { role: 'user', text: 'Plan a garden' },
    ]);
    const chat: Conversation = {
      id: crypto.randomUUID(),
      settings,
      title: 'Garden',
      createdAt: '',
      updatedAt: '',
      messages: [
        user,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          settings,
          createdAt: '',
          status: 'complete',
          blocks: [{ type: 'markdown', text: 'Grow basil.' }],
          promptTokensEstimate,
          usage: { input: 10000, contextInput: 1000, output: 500, cachedInput: 8000 },
        },
      ],
    };
    const context = contextFor(chat, settings, '', { ...automaticModel, contextWindow: 2000 });
    expect(context.estimated).toBeGreaterThan(1000);
    expect(context.estimated).toBeLessThan(1100);
    expect(context.reported).toBe(1000);
    expect(context.percent).toBe(50);
    expect(context.estimatedPercent).toBeGreaterThan(50);
    expect(
      contextFor(chat, settings, 'a'.repeat(400), { ...automaticModel, contextWindow: 2000 })
        .percent,
    ).toBe(50);
    expect(contextFor(chat, settings, 'a'.repeat(400), automaticModel).estimated).toBeGreaterThan(
      context.estimated + 90,
    );
    expect(
      contextFor(chat, { ...settings, provider: 'claude' }, '', automaticModel).calibrated,
    ).toBe(false);
    expect(recordedUsage(chat)).toMatchObject({ input: 10000, output: 500, cached: 8000 });
    const workspace = initialWorkspace();
    workspace.conversations = [chat];
    expect(restoreWorkspace(workspace).conversations[0].messages[1].usage?.contextInput).toBe(1000);
    chat.messages[1].usage = { input: null, output: 500 };
    expect(recordedUsage(chat)).toMatchObject({ inputMeasured: 0, outputMeasured: 1, missing: 1 });
  });
  it('uses measured context without requiring a local estimate and preserves the response window', () => {
    const chat = measuredChat();
    const currentCatalog = { ...automaticModel, contextWindow: 1e6 };
    const context = contextFor(chat, settings, '', currentCatalog);
    expect(context.reported).toBe(1200);
    expect(context.capacity).toBe(2000);
    expect(context.percent).toBe(60);
    expect(context.calibrated).toBe(false);
    chat.messages[0].usage!.contextWindow = null;
    expect(contextFor(chat, settings, '', automaticModel)).toMatchObject({
      reported: 1200,
      percent: null,
    });
    chat.messages[0].usage!.contextInput = 0;
    expect(contextFor(chat, settings, '', currentCatalog)).toMatchObject({
      reported: 0,
      percent: 0,
    });
  });
  it('does not call cumulative totals or a mismatched response measured context', () => {
    const chat = measuredChat();
    for (const changed of [
      { ...settings, provider: 'claude' as const },
      { ...settings, model: 'different' },
      { ...settings, reasoning: 'low' as const },
      { ...settings, instructions: 'Different instructions' },
    ])
      expect(contextFor(chat, changed, '', automaticModel).reported).toBeNull();
    chat.messages.push({
      ...chat.messages[0],
      id: crypto.randomUUID(),
      usage: { input: 9000, output: 200 },
    });
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
    chat.messages.at(-1)!.settings = { ...settings, provider: 'gemini' };
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
    expect(contextFor(undefined, settings, 'draft', automaticModel).reported).toBeNull();
  });
  it('keeps the previous measured reading during a reply, then replaces it only with new request data', () => {
    const chat = measuredChat();
    chat.messages.push({
      ...chat.messages[0],
      id: crypto.randomUUID(),
      status: 'running',
      usage: undefined,
    });
    expect(contextFor(chat, settings, 'draft', automaticModel)).toMatchObject({
      reported: 1200,
      streaming: true,
    });
    chat.messages.at(-1)!.usage = { input: 20000, contextInput: 1500, contextWindow: 2000 };
    expect(contextFor(chat, settings, '', automaticModel).percent).toBe(75);
    chat.messages.at(-1)!.status = 'complete';
    chat.messages.at(-1)!.usage = { input: 20000 };
    expect(contextFor(chat, settings, '', automaticModel).reported).toBeNull();
  });
});

function measuredChat(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'Fixture',
    settings,
    createdAt: '',
    updatedAt: '',
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: '',
        settings,
        blocks: [{ type: 'markdown', text: 'Grow basil.' }],
        usage: { input: 9000, output: 200, contextInput: 1200, contextWindow: 2000 },
      },
    ],
  };
}
