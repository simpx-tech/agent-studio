import { expect, it } from 'vitest';
import { createChangeMarks } from './change-marks';

it('starts with everything unsaved and unsynced', () => {
  const marks = createChangeMarks();
  expect(marks.unsaved()).toBe(true);
  expect(marks.takeUnsaved()).toBeUndefined();
  expect(marks.takeUnsynced()).toEqual({ chats: undefined, meta: true });
  expect(marks.unsaved()).toBe(false);
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(), meta: false });
});

it('names one conversation for the next save and the next sync', () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.takeUnsynced();
  marks.chat('a');
  marks.chat('b');
  expect(marks.takeUnsaved()).toEqual(new Set(['a', 'b']));
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(['a', 'b']), meta: false });
});

it('marks everything when a change names no conversation', () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.takeUnsynced();
  marks.chat('a');
  marks.chat();
  marks.chat('b');
  expect(marks.takeUnsaved()).toBeUndefined();
  expect(marks.takeUnsynced()).toEqual({ chats: undefined, meta: true });
});

it('keeps settings apart from the conversations', () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.takeUnsynced();
  marks.meta();
  expect(marks.unsaved()).toBe(true);
  // The index carries the settings, so the save sends no conversation.
  expect(marks.takeUnsaved()).toEqual(new Set());
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(), meta: true });
});

it('saves local and received data without publishing it', () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.takeUnsynced();
  marks.local();
  marks.received('a');
  expect(marks.unsaved()).toBe(true);
  expect(marks.takeUnsaved()).toEqual(new Set(['a']));
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(), meta: false });
  marks.received();
  expect(marks.takeUnsaved()).toBeUndefined();
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(), meta: false });
});

it('saves everything after a failed save', () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.chat('a');
  marks.takeUnsaved();
  marks.failedSave();
  expect(marks.unsaved()).toBe(true);
  expect(marks.takeUnsaved()).toBeUndefined();
});

it('hands unpublished changes back to the next sync', () => {
  const marks = createChangeMarks();
  marks.takeUnsynced();
  marks.chat('a');
  marks.meta();
  const taken = marks.takeUnsynced();
  // Changes made while that sync ran wait beside the ones it hands back.
  marks.chat('b');
  marks.restoreUnsynced(taken);
  expect(marks.takeUnsynced()).toEqual({ chats: new Set(['a', 'b']), meta: true });
  marks.restoreUnsynced({ chats: undefined, meta: false });
  expect(marks.takeUnsynced()).toEqual({ chats: undefined, meta: false });
});

it("keeps a running call's elapsed time apart from changes someone waits for", () => {
  const marks = createChangeMarks();
  marks.takeUnsaved();
  marks.takeUnsynced();
  marks.quiet('a', 'reply');
  marks.quiet('b', 'reply');
  // Saved like any change.
  expect(marks.takeUnsaved()).toEqual(new Set(['a', 'b']));
  // A conversation that changed otherwise too is published for that.
  marks.chat('b');
  const taken = marks.takeUnsynced();
  expect(taken).toEqual({ chats: new Set(['b']), meta: false, quiet: new Set(['a']) });
  // Handed back, it stays what it was.
  marks.restoreUnsynced(taken);
  expect(marks.takeUnsynced()).toEqual({
    chats: new Set(['b']),
    meta: false,
    quiet: new Set(['a']),
  });
  // A change that names nothing publishes everything anyway.
  marks.quiet('a', 'reply');
  marks.chat();
  expect(marks.takeUnsynced()).toEqual({ chats: undefined, meta: true });
});

it('tells which conversation and message each change touched', () => {
  const touched: [string | undefined, string | undefined][] = [];
  const marks = createChangeMarks((chat, message) => touched.push([chat, message]));
  marks.chat('a', 'reply');
  marks.quiet('a', 'reply');
  marks.received('b');
  marks.received();
  marks.chat('c');
  marks.chat();
  // Settings and this device's own choices touch no conversation.
  marks.meta();
  marks.local();
  expect(touched).toEqual([
    ['a', 'reply'],
    ['a', 'reply'],
    ['b', undefined],
    [undefined, undefined],
    ['c', undefined],
    [undefined, undefined],
  ]);
});
