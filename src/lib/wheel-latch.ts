/**
 * In the chat, the wheel over a view that zooms (a 3D model, a comparison's pane) zooms it
 * (requested 2026-10-21), unless it carries on a scroll of the conversation: a scroll that brought
 * the view under a pointer that has not moved since, with no pause. Browsers keep a wheel gesture
 * with the element it began on in the same way, so scrolling past a view never catches in it.
 */

/** A pause in the wheel this long ends a scroll of the conversation. */
export const SCROLL_PAUSE_MS = 500;
/** How far the pointer moves, in CSS pixels, before it aims at what lies under it. */
const STILL_PX = 4;

/** The last wheel that scrolled the page: when, and where the pointer was. */
export type WheelScroll = { at: number; x: number; y: number };

/** Whether `event` carries on `scroll` rather than turning to the view under the pointer. */
export function carriesOnScroll(
  event: Pick<WheelEvent, 'timeStamp' | 'clientX' | 'clientY' | 'ctrlKey' | 'cancelable'>,
  scroll: WheelScroll | undefined,
): boolean {
  // The browser scrolls the page with a wheel that began over content no view holds before the
  // page hears of it, then hands it over uncancelable, aimed at what the scroll brought under
  // the pointer: that wheel belongs to the scroll.
  if (!event.cancelable) return true;
  // A pinch, which arrives as a wheel with Ctrl held, always zooms.
  if (event.ctrlKey || !scroll) return false;
  return (
    event.timeStamp - scroll.at < SCROLL_PAUSE_MS &&
    Math.hypot(event.clientX - scroll.x, event.clientY - scroll.y) <= STILL_PX
  );
}

let last: WheelScroll | undefined;
// Every wheel reaches the window after the views it passed over: one that none of them took
// scrolled the page.
if (typeof window !== 'undefined')
  window.addEventListener(
    'wheel',
    (event) => {
      last = event.defaultPrevented
        ? undefined
        : { at: event.timeStamp, x: event.clientX, y: event.clientY };
    },
    { passive: true },
  );

/** Whether a wheel over a view in the chat scrolls the conversation on instead of zooming. */
export const scrollsOn = (event: WheelEvent) => carriesOnScroll(event, last);
