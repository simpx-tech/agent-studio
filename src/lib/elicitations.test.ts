import { describe, expect, it } from 'vitest';
import {
  elicitationReceiptSchema,
  elicitationInputSchema,
  formContent,
  mergeElicitations,
  safeElicitationUrl,
  type ElicitationReceipt,
  type ElicitationField,
} from './elicitations';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  initialWorkspace,
  historyFor,
  restoreWorkspace,
  workspaceSchema,
  type Message,
  type RunEvent,
} from './domain';
import { sharedWorkspace, mergeShared } from './sync';
import { attentionKeys } from './notifications';
import { forkConversation } from './forks';
const field = (key: string, kind: ElicitationField['kind'], required = true): ElicitationField => ({
  key,
  title: key,
  description: '',
  kind,
  required,
  options: [],
  minLength: null,
  maxLength: null,
  minimum: null,
  maximum: null,
  minItems: null,
  maxItems: null,
  format: null,
  pattern: null,
  default: null,
});
const fixture = () => {
  const m: Message = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant',
    status: 'running',
    blocks: [],
    createdAt: new Date().toISOString(),
  };
  const receipt: ElicitationReceipt = {
    id: crypto.randomUUID(),
    runId: m.runId!,
    revision: 1,
    status: 'pending',
    mode: 'form',
    serverName: 'fixture',
  };
  const w = initialWorkspace();
  w.conversations.push({
    id: crypto.randomUUID(),
    title: 'MCP input',
    createdAt: m.createdAt,
    updatedAt: m.createdAt,
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    messages: [m],
  });
  return { m, receipt, w };
};
describe('MCP elicitation', () => {
  it('preserves primitive types, false, zero, enum values and safe object keys', () => {
    const fields = [
      field('name', 'string'),
      field('count', 'integer'),
      field('enabled', 'boolean'),
      field('__proto__', 'string'),
      field('optional', 'number', false),
    ];
    expect(
      formContent(
        fields,
        new Map<string, unknown>([
          ['name', 'Ada'],
          ['count', '0'],
          ['enabled', false],
          ['__proto__', 'literal'],
        ]),
      ),
    ).toEqual(JSON.parse('{"name":"Ada","count":0,"enabled":false,"__proto__":"literal"}'));
    expect(() => formContent(fields, new Map())).toThrow();
    expect(() => formContent([field('count', 'integer')], new Map([['count', '1.5']]))).toThrow();
    expect(
      elicitationInputSchema.safeParse({
        requestId: crypto.randomUUID(),
        action: 'decline',
        content: { name: 'unexpected' },
      }).success,
    ).toBe(false);
  });
  it('persists only receipts, never private bodies, and keeps them out of prompts', () => {
    const { m, receipt, w } = fixture();
    const event: RunEvent = {
      kind: 'elicitation',
      elicitation: {
        ...receipt,
        message: 'PRIVATE MESSAGE',
        url: 'https://example.com/?token=SECRET',
        content: { name: 'PRIVATE ANSWER' },
      } as ElicitationReceipt,
    };
    const events: RunEvent[] = [];
    applyRunEvent(m, event);
    retainRunEvent(events, event);
    expect(m.elicitations).toEqual([receipt]);
    expect(events[0].elicitation).toEqual(receipt);
    m.status = 'complete';
    m.blocks = [{ type: 'markdown', text: 'Finished.' }];
    const restored = restoreWorkspace(w);
    expect(restored.conversations[0].messages[0].elicitations).toEqual([receipt]);
    expect(JSON.stringify(w)).not.toMatch(/PRIVATE|SECRET|requestedSchema/);
    expect(JSON.stringify(historyFor(w.conversations[0]))).not.toMatch(
      /serverName|elicitation|fixture/,
    );
    expect(elicitationReceiptSchema.parse({ ...receipt, url: 'PRIVATE' })).toEqual(receipt);
    const foreign = { ...event, elicitation: { ...receipt, runId: crypto.randomUUID() } };
    applyRunEvent(m, foreign);
    expect(m.elicitations).toEqual([receipt]);
    expect(
      workspaceSchema.safeParse({
        ...w,
        conversations: [
          { ...w.conversations[0], messages: [{ ...m, elicitations: [foreign.elicitation] }] },
        ],
      }).success,
    ).toBe(false);
  });
  it('retains revisions across older relays and closes forked prompts without reviving them', () => {
    const { m, receipt, w } = fixture();
    m.elicitations = [receipt];
    m.status = 'complete';
    const base = sharedWorkspace(w),
      old = structuredClone(base);
    delete old.conversations[0].messages[0].elicitations;
    old.conversations[0].title = 'Renamed';
    for (const [left, right] of [
      [base, old],
      [old, base],
    ])
      expect(mergeShared(base, left, right).conversations[0].messages[0].elicitations).toEqual([
        receipt,
      ]);
    const done = { ...receipt, revision: 2, status: 'accepted' as const };
    expect(mergeElicitations([done], [{ ...receipt, revision: 3 }])).toEqual([done]);
    expect(forkConversation(w.conversations[0]).messages[0].elicitations?.[0].status).toBe(
      'cancelled',
    );
    expect(attentionKeys(m)).toEqual([`elicitation:${receipt.id}`]);
    m.elicitations = [done];
    expect(attentionKeys(m)).toEqual([]);
  });
  it('blocks executable and credential-bearing URLs but permits HTTPS and local development', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///private',
      'https://user:pass@example.com',
      'http://example.com',
    ])
      expect(safeElicitationUrl(url)).toBe(false);
    expect(safeElicitationUrl('https://example.com/verify?nonce=123')).toBe(true);
    expect(safeElicitationUrl('http://127.0.0.1:4321/verify')).toBe(true);
  });
});
