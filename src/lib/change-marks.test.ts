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
