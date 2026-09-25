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

// Pending means Active and not working. Reading/opening a chat is irrelevant.
// The relay may know a run has ended before its final workspace checkpoint arrives.
export function pendingChatCount(
  conversations: readonly Pick<Conversation, 'archived' | 'messages'>[],
  runStatuses?: ReadonlyMap<string, string>,
): number {
  return conversations.filter(
    (c) =>
      !c.archived &&
      !c.messages.some(
        (m) =>
          m.role === 'assistant' &&
          m.status === 'running' &&
          !['complete', 'cancelled', 'error'].includes(
            runStatuses?.get(m.runId ?? '') ?? 'running',
          ),
      ),
  ).length;
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
  return message.blocks.some((block) => {
    if (block.type !== 'activity' || !block.tool || block.tool.parentId) return false;
    const name = block.tool.name.split(/[.:/]/).at(-1)?.toLowerCase();
    return ['askuserquestion', 'request_user_input', 'request_user_input_async'].includes(
      name ?? '',
    );
  });
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
            // Thrown errors are recorded as String(error).
            notificationLine(message.error, Infinity).replace(/^(?:Error:\s*)+/, ''),
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
    return receipt && `${receipt.serverName} requests your input.`;
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
  '#39': "'",
  apos: "'",
};
// Inline Markdown as a reader sees it: code spans and escaped characters stay literal, while
// link targets, images' addresses, HTML tags and emphasis markers are dropped.
function inline(text: string): string {
  const kept: string[] = [];
  const keep = (value: string) => `\uE000${kept.push(value) - 1}\uE001`;
  return text
    .replace(/[\uE000\uE001]/g, '')
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => keep(code.trim()))
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
    .replace(
      /<\/?(?:br|details|div|hr|img|li|ol|p|pre|summary|table|tbody|td|th|thead|tr|ul)\b[^<>]*>/gi,
      ' ',
    )
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/~~(\S(?:.*?\S)?)~~/g, '$1')
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?![\w_])/g, '$1$2')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_, name: string) => entities[name])
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => kept[Number(index)] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
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
  let length = 0;
  for (const raw of markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').split(/\r\n?|\n/)) {
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
    let line = raw
      .slice(0, 2000)
      .replace(/^\s*(?:>\s*)*/, '')
      .trim();
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
    else blocks.push({ text: line, heading });
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
 * Plain single-line text within `limit` code points, cut at a word where one is near. Lone
 * surrogates cannot cross native IPC, and control characters break toast XML.
 */
export function notificationLine(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (c) => (c.length === 2 ? c : ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\uE000\uE001\uFFFE\uFFFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  let cut = chars.slice(0, limit - 1).join('');
  const space = cut.lastIndexOf(' ');
  if (space > 0 && space >= cut.length - 20) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.·–—-]+$/, '')}…`;
}

export function notificationConversation(hash: string): string | undefined {
  return /^#conversation=([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.exec(hash)?.[1];
}
