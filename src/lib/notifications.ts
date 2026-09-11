import type { Message } from './domain';

export type NotificationKind = 'complete' | 'attention' | 'error' | 'cancelled' | 'test';
export type PushNotice = {
  kind: NotificationKind;
  conversationId?: string;
  tag: string;
};

// Only explicit parent tool identities indicate an in-progress question. Prose
// questions are covered by the finished-reply notification, in every language.
export function requestsAttention(message: Pick<Message, 'blocks'>): boolean {
  return message.blocks.some((block) => {
    if (block.type !== 'activity' || !block.tool || block.tool.parentId) return false;
    const name = block.tool.name.split(/[.:/]/).at(-1)?.toLowerCase();
    return ['askuserquestion', 'request_user_input', 'request_user_input_async'].includes(
      name ?? '',
    );
  });
}

export function notificationContent(notice: PushNotice) {
  const labels: Record<NotificationKind, [string, string]> = {
    complete: [
      'Reply ready',
      'Your agent finished its reply. Open the chat to read it or answer a question.',
    ],
    attention: [
      'Your attention is needed',
      'Your agent asked for your input. Open the chat to continue.',
    ],
    error: ['Your agent needs attention', 'A reply could not finish. Open the chat for details.'],
    cancelled: [
      'Your agent stopped',
      'The reply was stopped. Open the chat to review its progress.',
    ],
    test: [
      'Notifications are ready',
      'Agent Studio can notify you when work finishes or needs your attention.',
    ],
  };
  const [title, body] = labels[notice.kind] ?? labels.complete;
  return { title, body };
}

export function notificationConversation(hash: string): string | undefined {
  return /^#conversation=([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.exec(hash)?.[1];
}
