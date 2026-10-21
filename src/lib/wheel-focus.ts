/**
 * In the chat, a 3D view or a comparison zooms with the wheel only while the reader works with it
 * (requested 2026-10-21: "if I click on the 3D view it focus on it and allow to scroll to zoom and
 * if click elsewhere it focus on the chat and the scroll scrolls the chat"): while focus is within
 * its card, the element marked `data-wheel-scope`, which a click on the view gives it and a click
 * anywhere else takes back. Otherwise the wheel scrolls the chat.
 */

/** The attribute that marks the card a view takes the wheel for while focus is within it. */
export const WHEEL_SCOPE = 'data-wheel-scope';

/** Whether a view in the chat takes a wheel, given whether the reader works with its card. */
export function takesWheel(
  event: Pick<WheelEvent, 'cancelable' | 'ctrlKey'>,
  engaged: boolean,
): boolean {
  // The browser scrolls the chat with a wheel that began over content no view holds before the
  // page hears of it, then hands it over uncancelable, aimed at what the scroll brought under the
  // pointer: that wheel belongs to the scroll.
  if (!event.cancelable) return false;
  // A pinch, which arrives as a wheel with Ctrl held, zooms the view under the fingers.
  return engaged || event.ctrlKey;
}

/** Whether focus is within the card that holds `view`. */
export function engaged(view: Element): boolean {
  const scope = view.closest(`[${WHEEL_SCOPE}]`) ?? view;
  const active = view.ownerDocument.activeElement;
  return !!active && scope.contains(active);
}
