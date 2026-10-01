import type { Conversation, Message } from './domain';

export type NotificationKind = 'complete' | 'attention' | 'error' | 'cancelled' | 'test';
export type PushNotice = {
  kind: NotificationKind;
  conversationId?: string;
  tag: string;
  pendingCount?: number;
  // The chat's title and a line about its reply. Tests and older senders leave them out
  // and show the generic text of their kind.
  title?: string;
  body?: string;
};
// In Unicode code points. A push payload stays far below the 4 KB Web Push limit.
export const noticeTitleLimit = 80;
export const noticeBodyLimit = 180;

// Pending means Active and not working: idle, or waiting for your answer to a question or an
// MCP form. Reading/opening a chat is irrelevant. The relay may know that a run has ended, or
// waits for an answer (`waiting`), before its workspace checkpoint says so.
export function pendingChatCount(
  conversations: readonly Pick<Conversation, 'archived' | 'messages'>[],
  runStatuses?: ReadonlyMap<string, string>,
): number {
  return conversations.filter(
    (c) => !c.archived && !c.messages.some((m) => working(m, runStatuses)),
  ).length;
}
function working(m: Message, runStatuses?: ReadonlyMap<string, string>) {
  if (m.role !== 'assistant' || m.status !== 'running') return false;
  const run = runStatuses?.get(m.runId ?? '');
  if (run) return !['complete', 'cancelled', 'error', 'waiting'].includes(run);
  return !awaitingAnswer(m);
}
// A running reply waits for the user while one of its questions or MCP forms is pending.
// Here rather than in questions.ts, which re-exports it, so the service worker stays small.
export function awaitingAnswer(message: {
  questions?: { status: string }[];
  elicitations?: { status: string }[];
}) {
  return !!(
    message.questions?.some((q) => q.status === 'pending') ||
    message.elicitations?.some((e) => e.status === 'pending')
  );
}

export async function applyAppBadge(
  target: { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> },
  count: number,
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 0) return;
  if (count === 0 && target.clearAppBadge) await target.clearAppBadge();
  else await target.setAppBadge?.(count);
}

// Only explicit parent tool identities indicate an in-progress question. Prose
// questions are covered by the finished-reply notification, in every language.
export function requestsAttention(
  message: Pick<Message, 'blocks' | 'questions' | 'elicitations'>,
): boolean {
  if (message.elicitations?.some((e) => e.status === 'pending')) return true;
  if (message.questions?.length) return message.questions.some((q) => q.status === 'pending');
  return message.blocks.some(
    (block) =>
      block.type === 'activity' &&
      !!block.tool &&
      !block.tool.parentId &&
      asksTheUser(block.tool.name),
  );
}
/**
 * A question tool the model has started before its question is recorded. Claude reports
 * AskUserQuestion as it begins, seconds before the question, so an alert raised on the tool
 * alone waits for it: briefly on the desktop, and within its hold on the relay.
 */
export function provisionalAttention(
  message: Pick<Message, 'blocks' | 'questions' | 'elicitations'>,
): boolean {
  return !message.questions?.length && !message.elicitations?.length && requestsAttention(message);
}
/** Whether a tool of this name asks the user something, under any provider prefix. */
export function asksTheUser(tool: string): boolean {
  const name = tool.split(/[.:/]/).at(-1)?.toLowerCase();
  return ['askuserquestion', 'request_user_input', 'request_user_input_async'].includes(name ?? '');
}

export function attentionKeys(
  message: Pick<Message, 'blocks' | 'questions' | 'elicitations'>,
): string[] {
  const elicitationKeys =
    message.elicitations?.flatMap((e) => (e.status === 'pending' ? [`elicitation:${e.id}`] : [])) ??
    [];
  if (message.questions?.length)
    return [
      ...elicitationKeys,
      ...message.questions.flatMap((q, index) =>
        q.status === 'pending' ? [index === 0 ? 'attention' : `attention:${q.id}`] : [],
      ),
    ];
  if (message.elicitations?.length) return elicitationKeys;
  return requestsAttention(message) ? ['attention'] : [];
}

// Shown when a notice carries no text of its own, and always for tests.
const generic: Record<NotificationKind, [title: string, body: string]> = {
  complete: ['Reply ready', 'Your agent finished its reply.'],
  attention: ['Your attention is needed', 'Your agent asked for your input.'],
  error: ['Your agent needs attention', 'The reply could not finish.'],
  cancelled: ['Your agent stopped', 'The reply was stopped.'],
  test: [
    'Notifications are ready',
    'Agent Studio can notify you when work finishes or needs your attention.',
  ],
};

export function notificationContent(notice: PushNotice) {
  const [title, body] = generic[notice.kind] ?? generic.complete;
  if (notice.kind === 'test') return { title, body };
  return {
    title: notificationLine(notice.title, noticeTitleLimit) || title,
    body: notificationLine(notice.body, noticeBodyLimit) || body,
  };
}

/**
 * What a lifecycle alert says: the chat's title, and the start of the final answer, the
 * text a stopped reply had reached, the error, or the question waiting for an answer.
 */
export function chatNotification(
  kind: Exclude<NotificationKind, 'test'>,
  conversation: Pick<Conversation, 'title'>,
  message: Pick<Message, 'blocks' | 'error' | 'questions' | 'elicitations' | 'proposedPlans'>,
  key = 'terminal',
): { title: string; body: string } {
  const [title, fallback] = generic[kind];
  const labelled = (label: string, text: string) => (text ? `${label}: ${text}` : '');
  const body =
    kind === 'attention'
      ? waitingFor(message, key)
      : kind === 'error'
        ? labelled(
            'Failed',
            // Thrown errors are recorded as String(error), and may be long.
            notificationLine(
              typeof message.error === 'string' ? message.error.slice(0, noticeBodyLimit * 4) : '',
              Infinity,
            ).replace(/^(?:Error:\s*)+/, ''),
          )
        : kind === 'cancelled'
          ? labelled('Stopped', markdownText(answer(message) || progress(message)))
          : markdownText(answer(message) || message.proposedPlans?.findLast((p) => p.text)?.text);
  return {
    title: notificationLine(conversation.title, noticeTitleLimit) || title,
    body: notificationLine(body, noticeBodyLimit) || fallback,
  };
}
const answer = (message: Pick<Message, 'blocks'>) =>
  message.blocks
    .flatMap((b) => (b.type === 'markdown' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n\n');
// The latest progress comment, which holds the prose of a reply stopped before its answer.
// Agent Studio's own notices about starting a session are not the agent's words.
const progress = (message: Pick<Message, 'blocks'>) =>
  message.blocks.findLast(
    (b) =>
      b.type === 'activity' &&
      !!b.progress &&
      !b.progress.id.startsWith('studio-') &&
      typeof b.text === 'string' &&
      !!b.text.trim(),
  )?.text;
function waitingFor(
  message: Pick<Message, 'questions' | 'elicitations'>,
  key: string,
): string | undefined {
  if (key.startsWith('elicitation:')) {
    const receipt = message.elicitations?.find((e) => `elicitation:${e.id}` === key);
    // The server is named in the chat; its name comes from the CLI configuration, which
    // stays off lock screens.
    return receipt && 'An MCP server requests your input.';
  }
  // attentionKeys names the first question call `attention` and later ones by id.
  const request =
    key === 'attention'
      ? message.questions?.[0]
      : message.questions?.find((q) => `attention:${q.id}` === key);
  const question = markdownText(request?.questions[0]?.question);
  return question && `Question: ${question}`;
}

const entities: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
};
/** A character reference as the reader sees it; one it does not know stays as written. */
function entity(match: string, name: string): string {
  if (name[0] !== '#') return entities[name] ?? match;
  const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : '';
}
// Inline Markdown as a reader sees it: code spans and escaped characters stay literal, while
// link targets, images' addresses, HTML tags and emphasis markers are dropped.
function inline(text: string): string {
  const kept: string[] = [];
  const keep = (value: string) => `\uE000${kept.push(value) - 1}\uE001`;
  return (
    text
      .replace(/[\uE000\uE001]/g, '')
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) =>
        keep(code.trim()),
      )
      .replace(/\\([!-\/:-@[-`{-~])/g, (_, char: string) => keep(char))
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\^[^\]]*\]/g, '')
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^\s<>]+)>/gi, '$1')
      .replace(
        /<\/?(?:a|abbr|b|code|del|em|i|ins|kbd|mark|s|small|span|strong|sub|sup|u)\b[^<>]*>/gi,
        '',
      )
      // Any other tag, as the chat renders none of them as text.
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, ' ')
      .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
      .replace(/~~(\S(?:.*?\S)?)~~/g, '$1')
      .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1$2')
      .replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?![\w_])/g, '$1$2')
      .replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, entity)
      .replace(/\uE000(\d+)\uE001/g, (_, index: string) => kept[Number(index)] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Lines of `text` one at a time, so reading a long answer stops once it has enough. */
function* lines(text: string): Generator<string> {
  for (let start = 0; start <= text.length;) {
    const end = text.indexOf('\n', start);
    const stop = end < 0 ? text.length : end;
    yield text.slice(start, stop).replace(/\r$/, '');
    if (end < 0) return;
    start = end + 1;
  }
}
/**
 * A line without its HTML comments, and whether one stays open past it. A comment written
 * inside a code span is text the reader sees, so code spans are kept whole.
 */
function withoutComments(line: string): [string, boolean] {
  let open = false;
  const text = line.replace(
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|<!--[\s\S]*?(?:-->|$)/g,
    (match) => {
      if (match[0] === '`') return match;
      if (!match.endsWith('-->')) open = true;
      return ' ';
    },
  );
  return [text, open];
}
/**
 * Markdown as one line of what a reader sees. Code blocks, rules and comments (including
 * visualization markers) are dropped, and blocks are joined with a separator unless they end a
 * sentence. Reading stops once there is `enough` text for a notification.
 */
export function markdownText(markdown: unknown, enough = noticeBodyLimit * 2): string {
  if (typeof markdown !== 'string') return '';
  const blocks: { text: string; heading: boolean }[] = [];
  let fence = '';
  // The last line was paragraph or list text that a following line continues.
  let open = false;
  // The last block was a list item, whose indented lines continue it rather than start code.
  let listed = false;
  // An HTML comment, such as a visualization marker, hides the lines until it closes.
  let comment = false;
  let length = 0;
  for (let raw of lines(markdown)) {
    if (comment) {
      const end = raw.indexOf('-->');
      if (end < 0) continue;
      raw = raw.slice(end + 3);
      comment = false;
    }
    // Fences inside list items are indented further than CommonMark's three spaces.
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      const rest = raw
        .trim()
        .slice(marker?.length ?? 0)
        .trim();
      if (marker?.[0] === fence[0] && marker.length >= fence.length && !rest) fence = '';
      continue;
    }
    if (marker) {
      fence = marker;
      open = false;
      continue;
    }
    const [visible, unclosed] = withoutComments(raw.slice(0, 2000));
    comment = unclosed;
    // An indented code block, which cannot interrupt a paragraph or a list.
    if (!open && !listed && /^(?: {4}|\t)/.test(visible)) continue;
    let line = visible.replace(/^\s*(?:>\s*)*/, '').trim();
    // Link and footnote definitions show nothing where they stand.
    if (/^\[\^?[^\]]+\]:\s*\S/.test(line)) continue;
    if (
      !line ||
      /^([-*_=])(?:\s*\1){2,}$/.test(line) ||
      /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/.test(line)
    ) {
      open = false;
      continue;
    }
    const heading = /^#{1,6}(?:\s|$)/.test(line);
    const item = !heading && /^(?:[-*+]|\d{1,9}[.)])\s/.test(line);
    const row = !heading && line.startsWith('|');
    if (heading) line = line.replace(/^#+\s*/, '').replace(/\s+#+$/, '');
    else if (item) line = line.replace(/^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    else if (row)
      line = line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' · ');
    line = inline(line);
    if (!line) continue;
    if (open && !heading && !item && !row) blocks[blocks.length - 1].text += ` ${line}`;
    else {
      blocks.push({ text: line, heading });
      listed = item;
    }
    open = !heading && !row;
    length += line.length + 1;
    if (length >= enough) break;
  }
  return blocks.reduce(
    (text, block, index) =>
      index === 0
        ? block.text
        : text +
          (/[.!?:;…]$/.test(text) ? ' ' : blocks[index - 1].heading ? ': ' : ' · ') +
          block.text,
    '',
  );
}

/**
 * Plain single-line text within `limit` code points, cut at a word where one is near and
 * never inside a character a reader sees as one, such as a flag or a family emoji. Lone
 * surrogates cannot cross native IPC, control characters break toast XML, and direction
 * controls and invisible marks could reorder or hide what a model wrote.
 */
export function notificationLine(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (c) => (c.length === 2 ? c : ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\uE000\uE001\uFFFE\uFFFF]/g, ' ')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  let cut = graphemes(text, limit - 1);
  const space = cut.lastIndexOf(' ');
  if (space > 0 && space >= cut.length - 20) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.·–—-]+$/, '')}…`;
}

/** At most `count` code points of `text`, ending between the characters a reader sees. */
function graphemes(text: string, count: number): string {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl))
    return Array.from(text).slice(0, count).join('');
  let cut = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    text,
  )) {
    const size = Array.from(segment).length;
    if (used + size > count) break;
    cut += segment;
    used += size;
  }
  return cut;
}

export function notificationConversation(hash: string): string | undefined {
  return /^#conversation=([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.exec(hash)?.[1];
}
