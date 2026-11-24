import type { ChatSettings, Conversation, Message, ProviderId } from './domain';
import { formatModelName, replyModelName } from './replies';

/** The model and account a chat uses, which its row in the sidebar marks. */
export type ChatUses = { provider: ProviderId; model: string; connectionId?: string };

const sameModel = (a: ChatSettings, b: ChatSettings) =>
  a.provider === b.provider && a.model === b.model;

/**
 * What a chat uses: its running reply's model and account while one runs (`running`, which the
 * caller found), else the settings of its next reply, which its toolbar shows. A model the
 * chat's latest reply ran is named as that reply names it (Opus 5.5 for the opus alias or the
 * CLI default), any other by its id.
 */
export function chatUses(conversation: Conversation, running?: Message): ChatUses {
  const settings = conversation.settings;
  if (running?.settings)
    return {
      provider: running.settings.provider,
      model: replyModelName(running),
      connectionId: running.settings.connectionId ?? settings.connectionId,
    };
  let latest: Message | undefined;
  for (let index = conversation.messages.length - 1; index >= 0 && !latest; index--) {
    const message = conversation.messages[index];
    if (message.role === 'assistant' && message.settings) latest = message;
  }
  return {
    provider: settings.provider,
    model:
      latest?.settings && sameModel(latest.settings, settings)
        ? replyModelName(latest)
        : formatModelName(settings.model),
    connectionId: settings.connectionId,
  };
}
