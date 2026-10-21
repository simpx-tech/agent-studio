/**
 * Closes a modal dialog when the reader clicks its backdrop, an attachment for `<dialog>`.
 *
 * The press must begin on the backdrop as well, so a drag that starts inside the dialog
 * (panning an image, turning a model, selecting its text) keeps it open wherever it ends.
 */
export function closeOnBackdrop(dialog: HTMLDialogElement) {
  // The backdrop belongs to the dialog: its events target the dialog, outside the dialog's box.
  const outside = (event: MouseEvent) => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  };
  let pressed = false;
  // Either event starts a press: after a drag WebKit can send the mouse event alone, and a
  // pointer press whose default was prevented sends none. Both are heard before anything inside
  // the dialog can stop them.
  const press = (event: MouseEvent) => (pressed = outside(event));
  const click = (event: MouseEvent) => {
    if (pressed && outside(event)) dialog.close();
    pressed = false;
  };
  dialog.addEventListener('pointerdown', press, true);
  dialog.addEventListener('mousedown', press, true);
  dialog.addEventListener('click', click);
  return () => {
    dialog.removeEventListener('pointerdown', press, true);
    dialog.removeEventListener('mousedown', press, true);
    dialog.removeEventListener('click', click);
  };
}

/**
 * Closes a dialog that covers the window when the reader clicks its scrim: the dialog itself and
 * every element it marks `data-scrim`, the room around what it shows. As with `closeOnBackdrop`,
 * the press must begin on the scrim too, so a drag that starts on a picture or a control keeps
 * the dialog open wherever it ends.
 */
export function closeOnScrim(dialog: HTMLDialogElement) {
  const scrim = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (event.button || !target) return false;
    return (
      target === dialog ||
      (typeof target.hasAttribute === 'function' && target.hasAttribute('data-scrim'))
    );
  };
  let pressed = false;
  const press = (event: MouseEvent) => (pressed = scrim(event));
  const click = (event: MouseEvent) => {
    if (pressed && scrim(event)) dialog.close();
    pressed = false;
  };
  dialog.addEventListener('pointerdown', press, true);
  dialog.addEventListener('mousedown', press, true);
  dialog.addEventListener('click', click);
  return () => {
    dialog.removeEventListener('pointerdown', press, true);
    dialog.removeEventListener('mousedown', press, true);
    dialog.removeEventListener('click', click);
  };
}
