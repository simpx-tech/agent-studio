import { describe, expect, it } from 'vitest';
import type { Message } from './domain';
import {
  chatNotification,
  markdownText,
  noticeBodyLimit,
  notificationContent,
  notificationLine,
} from './notifications';

type Reply = Parameters<typeof chatNotification>[2];
const reply = (blocks: Message['blocks'], extra: Partial<Reply> = {}): Reply => ({
  blocks,
  ...extra,
});
const progress = (id: string, text: string): Message['blocks'][number] => ({
  type: 'activity',
  text,
  progress: { id, revision: 1 },
});
const question = (id: string, text: string, status = 'pending' as const) => ({
  id,
  revision: 1,
  status,
  questions: [{ id: 'q', header: 'Branch', question: text, options: [], multiSelect: false }],
});

describe('markdownText', () => {
  it('reads a reply as one line of what the reader sees', () => {
    const answer = [
      '<!-- visualize:chart -->',
      '## Summary',
      'Notifications now show the **chat title** and the',
      'start of the [reply](https://example.com/a_(b)).',
      '',
      '- `src/lib/notifications.ts` builds the text',
      '1. Run the tests:',
      '   ```bash',
      '   npm test',
      '   ```',
      '2. Check ![the toast](toast.png) on <https://example.com>',
      '',
      '| File | Change |',
      '| --- | :-: |',
      '| a.ts | *new* |',
      '',
      '---',
      '> Quoted ~~old~~ note with an escaped \\*star\\* and `a*b*c`',
    ].join('\n');
    expect(markdownText(answer)).toBe(
      'Summary: Notifications now show the chat title and the start of the reply. ' +
        'src/lib/notifications.ts builds the text · Run the tests: ' +
        'Check the toast on https://example.com · File · Change · a.ts · new · ' +
        'Quoted old note with an escaped *star* and a*b*c',
    );
  });

  it('keeps identifiers, code-like text and entities readable', () => {
    expect(markdownText('Use snake_case_names, `Vec<String>` & __init__ in C#.')).toBe(
      'Use snake_case_names, Vec<String> & init in C#.',
    );
    expect(markdownText('Press <kbd>Ctrl</kbd>+<b>N</b>,<br>then &amp; 2 &lt; 3')).toBe(
      'Press Ctrl+N, then & 2 < 3',
    );
  });

  it('drops code blocks, including unclosed ones, and stops once it has enough text', () => {
    expect(markdownText('```ts\nconst hidden = 1;\n```')).toBe('');
    expect(markdownText('Before\n~~~\nstreaming code')).toBe('Before');
    const long = Array.from({ length: 100 }, (_, i) => `Line ${i}.`).join('\n\n');
    expect(markdownText(long, 40).split(' ').length).toBeLessThan(20);
    expect(markdownText(undefined)).toBe('');
  });
});

describe('notificationLine', () => {
  it('cuts at a word within the limit, counting code points', () => {
    const text = notificationLine(`${'a'.repeat(50)} ${'word '.repeat(40)}`, 80);
    expect(Array.from(text).length).toBeLessThanOrEqual(80);
    expect(text).toMatch(/ word…$/);
    const emoji = notificationLine('🙂'.repeat(100), 10);
    expect(emoji).toBe(`${'🙂'.repeat(9)}…`);
  });

  it('removes control characters and lone surrogates that native IPC or toast XML reject', () => {
    expect(notificationLine('a\u0000b\u001f c\ud800 d\u2028e\uFFFFf', 80)).toBe('a b c d e f');
    expect(notificationLine(42, 80)).toBe('');
  });
});

describe('chatNotification', () => {
  const chat = { title: 'Fix\nnotification   titles' };

  it('shows the chat title and the start of a completed answer', () => {
    const body = `Done. ${'The desktop and phone alerts use the chat. '.repeat(10)}`;
    const notice = chatNotification('complete', chat, reply([{ type: 'markdown', text: body }]));
    expect(notice.title).toBe('Fix notification titles');
    expect(notice.body.startsWith('Done. The desktop and phone alerts')).toBe(true);
    expect(Array.from(notice.body).length).toBeLessThanOrEqual(noticeBodyLimit);
    expect(notice.body.endsWith('…')).toBe(true);
  });

  it('falls back to a proposed plan, then to generic text of its kind', () => {
    const plan = { id: 'p', revision: 1, text: '# Plan\n1. Add titles', complete: true };
    expect(
      chatNotification(
        'complete',
        chat,
        reply([], { proposedPlans: [{ ...plan, truncated: false }] }),
      ).body,
    ).toBe('Plan: Add titles');
    expect(chatNotification('complete', { title: ' ' }, reply([]))).toEqual({
      title: 'Reply ready',
      body: 'Your agent finished its reply.',
    });
  });

  it('says a reply stopped with the text it had reached, never an Agent Studio notice', () => {
    const blocks = [
      progress('p1', 'Reading the relay.'),
      progress('p2', 'Now editing **push.ts**.'),
      progress('studio-session-bootstrap', 'Continuing this older chat from its saved messages.'),
    ];
    expect(chatNotification('cancelled', chat, reply(blocks)).body).toBe(
      'Stopped: Now editing push.ts.',
    );
    expect(
      chatNotification('cancelled', chat, reply([...blocks, { type: 'markdown', text: 'Partial' }]))
        .body,
    ).toBe('Stopped: Partial');
    expect(chatNotification('cancelled', chat, reply([])).body).toBe('The reply was stopped.');
  });

  it('says a reply failed with its error', () => {
    expect(
      chatNotification('error', chat, reply([], { error: 'Error: Claude exited:\nrate limit' }))
        .body,
    ).toBe('Failed: Claude exited: rate limit');
    expect(chatNotification('error', chat, reply([])).body).toBe('The reply could not finish.');
  });

  it('shows the question each attention key names', () => {
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const elicitation = crypto.randomUUID();
    const waiting = reply([], {
      questions: [question(first, 'Which `branch` should I merge?'), question(second, 'Ship it?')],
      elicitations: [
        {
          id: elicitation,
          runId: crypto.randomUUID(),
          revision: 1,
          status: 'pending',
          mode: 'form',
          serverName: 'github',
        },
      ],
    });
    expect(chatNotification('attention', chat, waiting, 'attention').body).toBe(
      'Question: Which branch should I merge?',
    );
    expect(chatNotification('attention', chat, waiting, `attention:${second}`).body).toBe(
      'Question: Ship it?',
    );
    expect(chatNotification('attention', chat, waiting, `elicitation:${elicitation}`).body).toBe(
      'github requests your input.',
    );
    // A question tool without a recorded question keeps the generic line.
    expect(chatNotification('attention', chat, reply([]), 'attention').body).toBe(
      'Your agent asked for your input.',
    );
  });
});

describe('notificationContent', () => {
  it('shows received text as bounded plain text, and generic text for tests or none', () => {
    const tag = 'studio-x';
    expect(
      notificationContent({ kind: 'cancelled', tag, title: 'Chat\n', body: 'Stopped: x' }),
    ).toEqual({ title: 'Chat', body: 'Stopped: x' });
    expect(
      notificationContent({ kind: 'error', tag, title: '', body: 'b'.repeat(500) }).title,
    ).toBe('Your agent needs attention');
    expect(
      Array.from(notificationContent({ kind: 'error', tag, body: 'b'.repeat(500) }).body).length,
    ).toBe(noticeBodyLimit);
    expect(notificationContent({ kind: 'test', tag, title: 'Injected' }).title).toBe(
      'Notifications are ready',
    );
  });
});
