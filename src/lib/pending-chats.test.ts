import { expect, it, vi } from 'vitest';
import { applyAppBadge, pendingChatCount } from './notifications';
import type { Conversation, Message } from './domain';

function chat(status?: Message['status'], archived = false) {
  return {
    archived,
    messages: status ? [{ role: 'assistant', status, runId: 'run' }] : [],
  } as Pick<Conversation, 'archived' | 'messages'>;
}
it('counts all idle Active chats, including stopped and failed chats, independently of reading', () => {
  const chats = [
    chat('complete'),
    chat('error'),
    chat('cancelled'),
    chat(),
    chat('running'),
    chat('complete', true),
    chat('running', true),
  ];
  expect(pendingChatCount(chats)).toBe(4);
  chats[0].messages[0].status = 'running';
  expect(pendingChatCount(chats)).toBe(3);
  chats[1].archived = true;
  expect(pendingChatCount(chats)).toBe(2);
  chats.splice(2, 1);
  expect(pendingChatCount(chats)).toBe(1);
  expect(pendingChatCount([])).toBe(0);
});
it('uses a matching relay run result before its final checkpoint, never an unrelated job', () => {
  const chats = [chat('running'), chat('complete', true)];
  expect(pendingChatCount(chats, new Map([['other-run', 'complete']]))).toBe(0);
  expect(pendingChatCount(chats, new Map([['run', 'queued']]))).toBe(0);
  expect(pendingChatCount(chats, new Map([['run', 'complete']]))).toBe(1);
  expect(pendingChatCount(chats, new Map([['run', 'error']]))).toBe(1);
});
it('sets exact web counts, clears zero, and tolerates unsupported browser APIs', async () => {
  const target = {
    setAppBadge: vi.fn(async (_count: number) => {}),
    clearAppBadge: vi.fn(async () => {}),
  };
  await applyAppBadge(target, 12);
  await applyAppBadge(target, 0);
  await applyAppBadge(target, -1);
  await applyAppBadge(target, NaN);
  await applyAppBadge(target, 1.5);
  expect(target.setAppBadge).toHaveBeenCalledExactlyOnceWith(12);
  expect(target.clearAppBadge).toHaveBeenCalledTimes(1);
  await expect(applyAppBadge({}, 3)).resolves.toBeUndefined();
});
