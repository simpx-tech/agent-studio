// Reaching the menu button with a thumb is awkward on a phone. A swipe from the
// left border opens the conversation drawer instead, and a swipe back across it
// closes it again, following the finger until it lifts.

/** How far from the left border a touch can start an opening swipe. */
export const edgeZone = 28;
/** Travel that decides whether the drawer or the content below it owns a touch. */
const lock = 10;
/** Share of the drawer's width that settles a released swipe in its new state. */
const commit = 0.4;
/** Recent speed, in pixels per millisecond, that settles it whatever the distance. */
const flick = 0.45;
/** How long a position stays the reference for that speed. */
const sample = 100;

export type DrawerSwipe = {
  /** The drawer's own width: the travel between closed and open. */
  width: number;
  /** Whether the drawer was open when the finger landed. */
  open: boolean;
  /** Where the finger landed. */
  x: number;
  y: number;
  /** The latest position, with a recent one to measure a flick against. */
  at: { x: number; y: number; time: number };
  from: { x: number; time: number };
  /** Set once the travel claimed this touch for the drawer. */
  moving?: boolean;
};

/** Where the swipe has taken the drawer, from 0 closed to 1 fully open. */
export function swipeProgress(swipe: DrawerSwipe): number {
  const travel = swipe.at.x - swipe.x + (swipe.open ? swipe.width : 0);
  return Math.max(0, Math.min(1, travel / swipe.width));
}

/** Whether the drawer takes this touch, hands it back, or still awaits a direction. */
export function swipeClaims(swipe: DrawerSwipe): boolean | undefined {
  const x = swipe.at.x - swipe.x,
    y = swipe.at.y - swipe.y;
  if (Math.abs(x) < lock && Math.abs(y) < lock) return undefined;
  // A mostly vertical drag scrolls the list or conversation it started in.
  if (Math.abs(x) <= Math.abs(y)) return false;
  return swipe.open ? x < 0 : x > 0;
}

/** Whether the drawer stays open once the finger lifts at `time`. */
export function swipeSettles(swipe: DrawerSwipe, time: number): boolean {
  // A finger that stopped before lifting has no speed left, however fast it moved.
  const elapsed = Math.max(time, swipe.at.time) - swipe.from.time;
  const speed = elapsed > 0 ? (swipe.at.x - swipe.from.x) / elapsed : 0;
  if (Math.abs(speed) >= flick) return speed > 0;
  return swipeProgress(swipe) >= (swipe.open ? 1 - commit : commit);
}

export type DrawerSwipeOptions = {
  /** Whether a swipe can start: a phone-width window with nothing modal in the way. */
  enabled: () => boolean;
  /** The drawer's current state. */
  open: () => boolean;
  /** The drawer itself, absent until the workspace is on screen. */
  drawer: () => HTMLElement | undefined;
  /** Follows the finger from 0 to 1, and undefined when no swipe is moving it. */
  move: (progress: number | undefined) => void;
  /** The state a released swipe settles in. */
  settle: (open: boolean) => void;
};

/** Dialogs, confirmations and menus own the touches over the page they cover. */
function covered() {
  return !!document.querySelector('dialog:modal, .modal-backdrop, [popover]:popover-open');
}

/** A list the finger can still scroll that way keeps the swipe for itself. */
function scrolls(target: EventTarget | null, rightwards: boolean) {
  let element = target instanceof Element ? target : null;
  for (; element; element = element.parentElement) {
    const { scrollLeft, scrollWidth, clientWidth } = element;
    if (scrollWidth - clientWidth < 2) continue;
    const overflow = getComputedStyle(element).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    if (rightwards ? scrollLeft > 1 : scrollLeft < scrollWidth - clientWidth - 1) return true;
  }
  return false;
}

export function trackDrawerSwipe(options: DrawerSwipeOptions) {
  let swipe: DrawerSwipe | undefined;

  function drop() {
    const moving = swipe?.moving;
    swipe = undefined;
    // Ordinary scrolling keeps the compositor's fast path between swipes.
    window.removeEventListener('touchmove', move);
    if (moving) options.move(undefined);
  }
  function start(event: TouchEvent) {
    drop();
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch || !options.enabled()) return;
    const width = options.drawer()?.offsetWidth ?? 0;
    const open = options.open();
    // Closed, only the border starts a swipe, so content keeps its own gestures.
    if (width <= 0 || (!open && touch.clientX > edgeZone)) return;
    if (covered() || scrolls(event.target, !open)) return;
    const at = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    swipe = { width, open, x: at.x, y: at.y, at, from: { x: at.x, time: at.time } };
    window.addEventListener('touchmove', move, { passive: false });
  }
  function move(event: TouchEvent) {
    const touch = event.touches[0];
    if (!swipe) return;
    if (event.touches.length !== 1 || !touch) {
      drop();
      return;
    }
    const previous = swipe.at;
    swipe.at = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    if (!swipe.moving) {
      const claim = swipeClaims(swipe);
      if (claim === undefined) return;
      if (!claim) {
        drop();
        return;
      }
      swipe.moving = true;
      swipe.from = { x: previous.x, time: previous.time };
    } else if (swipe.at.time - swipe.from.time > sample)
      swipe.from = { x: previous.x, time: previous.time };
    // The drawer owns this touch now, so the page below must not scroll with it.
    if (event.cancelable) event.preventDefault();
    options.move(swipeProgress(swipe));
  }
  function end(event: TouchEvent) {
    const released = swipe;
    drop();
    if (released?.moving) options.settle(swipeSettles(released, event.timeStamp));
  }

  window.addEventListener('touchstart', start, { passive: true });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', drop);
  return () => {
    drop();
    window.removeEventListener('touchstart', start);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', drop);
  };
}
