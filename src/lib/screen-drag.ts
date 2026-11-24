// Moving the Screens tab's screens and groups into groups by dragging them (requested
// 2026-11-24). What is moved is pressed on its element marked `data-screen-drag` (`screen:<id>`
// or `group:<id>`) with the mouse or a pen; once the pointer moves a few pixels, the element
// marked `data-screen-lift` around it lifts and follows the pointer, and the place under the
// pointer, an element marked `data-screen-drop` (a group's id, or empty for the top of its
// computer) within the same `data-screen-computer`, shows where it would land. Releasing it there
// tells the page; Escape or a lost pointer puts it back, and the click that ends a drag does
// nothing. Touches are left to scroll the list and to open menus. Nothing here knows the page.

export type ScreenDragItem = { kind: 'screen' | 'group'; id: string; computer: string };
/** Where a dragged screen or group would land: a group, or the top of its computer. */
export type ScreenDropTarget = { group?: string; computer: string };

// How far the pointer moves before a press becomes a drag, the band at each end of the scrolling
// list that scrolls it while something is dragged there, and the fastest it scrolls, in pixels a
// second, so every display scrolls as fast however often it draws.
const THRESHOLD = 5;
const EDGE = 40;
const SPEED = 900;

function scrollingParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      parent.scrollHeight > parent.clientHeight
    )
      return parent;
  }
}

/** The place under a point that takes `item`, if any. */
function placeAt(
  x: number,
  y: number,
  item: ScreenDragItem,
  accepts: (item: ScreenDragItem, target: ScreenDropTarget) => boolean,
): { element: HTMLElement; target: ScreenDropTarget } | undefined {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-screen-drop]');
  if (!element) return;
  const computer = element.closest<HTMLElement>('[data-screen-computer]')?.dataset.screenComputer;
  if (computer !== item.computer) return;
  const target = {
    computer,
    ...(element.dataset.screenDrop ? { group: element.dataset.screenDrop } : {}),
  };
  return accepts(item, target) ? { element, target } : undefined;
}

/**
 * Follows a press on a screen or a group. Once the pointer moves a few pixels it is dragged, and
 * releasing it over a place that `accepts` it tells `drop`.
 */
export function pressToFile(
  event: PointerEvent,
  accepts: (item: ScreenDragItem, target: ScreenDropTarget) => boolean,
  drop: (item: ScreenDragItem, target: ScreenDropTarget) => void,
) {
  if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) return;
  const [kind, id] = (handle.dataset.screenDrag ?? '').split(':');
  const computer = handle.closest<HTMLElement>('[data-screen-computer]')?.dataset.screenComputer;
  if ((kind !== 'screen' && kind !== 'group') || !id || !computer) return;
  const item: ScreenDragItem = { kind, id, computer };
  const lifted = handle.closest<HTMLElement>('[data-screen-lift]') ?? handle;
  const scroller = scrollingParent(handle);
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  const startScroll = scroller?.scrollTop ?? 0;
  let x = startX;
  let y = startY;
  let dragging = false;
  let over: { element: HTMLElement; target: ScreenDropTarget } | undefined;
  let frame = 0;
  let drawn: number | undefined;

  const follow = () => {
    const scrolled = (scroller?.scrollTop ?? 0) - startScroll;
    lifted.style.transform = `translate(${x - startX}px, ${y - startY + scrolled}px)`;
    const next = placeAt(x, y, item, accepts);
    if (next?.element !== over?.element) {
      over?.element.classList.remove('screen-drop-target');
      next?.element.classList.add('screen-drop-target');
    }
    over = next;
  };
  const scrollFrame = (now: number) => {
    const elapsed = Math.min(50, now - (drawn ?? now));
    drawn = now;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      const step =
        y < bounds.top + EDGE
          ? -Math.min(1, (bounds.top + EDGE - y) / EDGE)
          : y > bounds.bottom - EDGE
            ? Math.min(1, (y - (bounds.bottom - EDGE)) / EDGE)
            : 0;
      const before = scroller.scrollTop;
      if (step) scroller.scrollTop += (step * SPEED * elapsed) / 1000;
      if (scroller.scrollTop !== before) follow();
    }
    frame = requestAnimationFrame(scrollFrame);
  };
  const pointermove = (moved: PointerEvent) => {
    if (moved.pointerId !== pointerId) return;
    x = moved.clientX;
    y = moved.clientY;
    if (!dragging) {
      if (Math.hypot(x - startX, y - startY) < THRESHOLD) return;
      dragging = true;
      lifted.classList.add('screen-lifted');
      document.documentElement.classList.add('screen-dragging');
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // The window's events follow the drag either way.
      }
      frame = requestAnimationFrame(scrollFrame);
    }
    moved.preventDefault();
    follow();
  };
  const finish = (how: 'drop' | 'cancel') => {
    window.removeEventListener('pointermove', pointermove, true);
    window.removeEventListener('pointerup', pointerup, true);
    window.removeEventListener('pointercancel', pointercancel, true);
    window.removeEventListener('keydown', keydown, true);
    cancelAnimationFrame(frame);
    if (!dragging) return;
    // The click that ends a drag opens and folds nothing.
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    over?.element.classList.remove('screen-drop-target');
    document.documentElement.classList.remove('screen-dragging');
    const landed = how === 'drop' ? over?.target : undefined;
    if (landed) {
      lifted.classList.remove('screen-lifted');
      lifted.style.transform = '';
      drop(item, landed);
      return;
    }
    // Put back where it was.
    lifted.classList.add('screen-returning');
    lifted.classList.remove('screen-lifted');
    lifted.style.transform = '';
    const settled = () => lifted.classList.remove('screen-returning');
    lifted.addEventListener('transitionend', settled, { once: true });
    setTimeout(settled, 300);
  };
  const pointerup = (released: PointerEvent) => {
    if (released.pointerId === pointerId) finish('drop');
  };
  const pointercancel = (cancelled: PointerEvent) => {
    if (cancelled.pointerId === pointerId) finish('cancel');
  };
  const keydown = (key: KeyboardEvent) => {
    if (key.key !== 'Escape') return;
    if (dragging) {
      key.preventDefault();
      key.stopPropagation();
    }
    finish('cancel');
  };
  window.addEventListener('pointermove', pointermove, true);
  window.addEventListener('pointerup', pointerup, true);
  window.addEventListener('pointercancel', pointercancel, true);
  window.addEventListener('keydown', keydown, true);
}
