import { expect, it } from 'vitest';
import { closeOnBackdrop, closeOnScrim } from './dialog-backdrop';

/** A dialog at 100–300 × 100–200 that keeps its listeners, so a test can send events from anywhere. */
function dialogAt() {
  const listeners = new Map<string, (event: unknown) => void>();
  const dialog = {
    open: true,
    close: () => (dialog.open = false),
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 200 }),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const detach = closeOnBackdrop(dialog as unknown as HTMLDialogElement);
  const send = (type: string, clientX: number, clientY: number, target: unknown = dialog) =>
    listeners.get(type)?.({ type, target, clientX, clientY });
  return { dialog, listeners, detach, send };
}
/** An element inside the dialog, such as the zoom stage or the file's name. */
const child = {};

it('closes on a click on the backdrop that began there', () => {
  const { dialog, send } = dialogAt();
  send('pointerdown', 50, 150);
  send('mousedown', 50, 150);
  send('click', 50, 150);
  expect(dialog.open).toBe(false);
});

it('counts a press from either event, as WebKit sends the mouse event alone after a drag', () => {
  for (const press of ['pointerdown', 'mousedown']) {
    const { dialog, send } = dialogAt();
    send(press, 320, 250);
    send('click', 320, 250);
    expect(dialog.open).toBe(false);
  }
});

it('stays open after a drag that began inside, a press released inside, and a click on its padding', () => {
  const { dialog, send } = dialogAt();
  // Panning an image or selecting the file's name out onto the backdrop.
  send('pointerdown', 150, 150, child);
  send('mousedown', 150, 150, child);
  send('click', 50, 150);
  // A press on the backdrop released over the dialog.
  send('pointerdown', 50, 150);
  send('click', 150, 150);
  // The dialog's own padding is part of it.
  send('pointerdown', 101, 150);
  send('click', 101, 150);
  // A press is used once: a click without its own press, such as one from the keyboard.
  send('pointerdown', 50, 150);
  send('click', 120, 120);
  send('click', 50, 150);
  expect(dialog.open).toBe(true);
});

it('lets go of the dialog when detached', () => {
  const { listeners, detach } = dialogAt();
  expect([...listeners.keys()].sort()).toEqual(['click', 'mousedown', 'pointerdown']);
  detach();
  expect(listeners.size).toBe(0);
});

/** A dialog covering the window, whose marked elements are its scrim. */
function windowDialog() {
  const listeners = new Map<string, (event: unknown) => void>();
  const dialog = {
    open: true,
    close: () => (dialog.open = false),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const detach = closeOnScrim(dialog as unknown as HTMLDialogElement);
  const send = (type: string, target: unknown, button = 0) =>
    listeners.get(type)?.({ type, target, button });
  return { dialog, listeners, detach, send };
}
const element = (scrim: boolean) => ({
  hasAttribute: (name: string) => scrim && name === 'data-scrim',
});

it('closes a window-wide dialog on a click on its scrim that began there', () => {
  for (const target of ['dialog', 'room']) {
    const { dialog, send } = windowDialog();
    const on = target === 'dialog' ? dialog : element(true);
    send('pointerdown', on);
    send('click', on);
    expect(dialog.open).toBe(false);
  }
});

it('keeps a window-wide dialog open for what it shows, drags off it and other buttons', () => {
  const { dialog, send } = windowDialog();
  const picture = element(false);
  const room = element(true);
  // A click on what the dialog shows, or on one of its controls.
  send('pointerdown', picture);
  send('click', picture);
  // A drag from the picture out onto the scrim, and a press on the scrim released on it.
  send('pointerdown', picture);
  send('click', room);
  send('pointerdown', room);
  send('click', picture);
  // The middle or right button.
  send('pointerdown', room, 1);
  send('click', room, 1);
  send('mousedown', room, 2);
  send('click', room, 2);
  expect(dialog.open).toBe(true);
});
