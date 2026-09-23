// Keeps conversation content in place while the reader expands or collapses parts of it.
//
// Collapsing near the end shortens the conversation below the scroll position, and the
// browser would pull every message down to the new end. Instead, blank virtual space
// after the messages holds the reading position. The space only fills the gap below the
// real end: scrolling up, new content, and a smaller viewport consume it, and it never
// lets the reader scroll further down than the held position.

// Controls whose activation changes the height of the content they disclose. Popup
// triggers such as dropdowns are excluded because they do not change the layout.
const disclosures = 'summary, [aria-expanded]:not([aria-haspopup]), [role="tab"]';
const tabKeys = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

type Anchor = { element: Element; offset: number };

/**
 * `up` when the reader scrolled up through held space, `held` while space still holds
 * the position, and `free` when there is none.
 */
export type ScrollHold = 'up' | 'held' | 'free';

export interface VirtualSpace {
  /** Consumes the space a scroll moved away from and reports what remains. */
  scrolled(): ScrollHold;
  /** Consumes the space that new content or a smaller viewport now covers. */
  trim(): void;
  /** Removes the space and any pending adjustment, for example for another conversation. */
  clear(): void;
  destroy(): void;
}

/**
 * @param scroller The scrolling conversation viewport.
 * @param content Its messages. Disclosure controls activated inside it hold their position.
 * @param spacer An empty element after `content` that provides the space.
 * @param moved Called once an expansion or collapse has been laid out and its position
 *   held, like a scroll event.
 */
export function createVirtualSpace(
  scroller: HTMLElement,
  content: HTMLElement,
  spacer: HTMLElement,
  moved: () => void,
): VirtualSpace {
  let height = 0;
  let pending: { anchors: Anchor[]; top: number } | undefined;
  let frame = 0;

  const offset = (element: Element) =>
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  // Blank space shown below the real end; negative while the conversation continues below.
  const gap = () => scroller.clientTop + scroller.clientHeight - offset(spacer);
  // Space that keeps `target` a valid scroll position. The top is always valid.
  const needed = (target: number) => (target > 0 ? target - scroller.scrollTop + gap() : 0);

  function resize(next: number) {
    // Fractional sizes keep the scroll range exact; rounding would leave a pixel to scroll.
    // Less than a pixel is layout rounding at the end, not a position worth holding.
    next = next < 1 ? 0 : next;
    if (next === height) return;
    height = next;
    spacer.style.height = next ? `${next}px` : '';
  }
  function trim() {
    if (height) resize(Math.min(height, needed(scroller.scrollTop)));
  }
  // Like the browser's scroll anchor: the deepest first element reaching below the top edge.
  function topAnchor(
    parent: Element = content,
    edge = scroller.getBoundingClientRect().top + scroller.clientTop,
  ): Element | undefined {
    const child = Array.from(parent.children).find((element) => {
      const box = element.getBoundingClientRect();
      return (box.width > 0 || box.height > 0) && box.bottom > edge;
    });
    if (!child || child.getBoundingClientRect().top >= edge) return child;
    return topAnchor(child, edge) ?? child;
  }
  function hold(control: Element) {
    // Several activations within one frame are measured against the original layout.
    pending ??= {
      // Visible content stays put. When a collapse removes it, the control stays instead.
      anchors: [topAnchor(), control].flatMap((element) =>
        element ? [{ element, offset: offset(element) }] : [],
      ),
      top: scroller.scrollTop,
    };
    if (!frame) frame = requestAnimationFrame(settle);
  }
  // Runs before the next paint, once the activation has changed the layout. The browser may
  // already have clamped the scroll position to the shorter conversation.
  function settle() {
    const held = pending;
    pending = undefined;
    frame = 0;
    if (!held) return;
    const top = scroller.scrollTop;
    const anchor = held.anchors.find(
      ({ element }) => element.isConnected && element.getClientRects().length > 0,
    );
    const target = Math.max(0, anchor ? top + offset(anchor.element) - anchor.offset : held.top);
    resize(needed(target));
    scroller.scrollTop = target;
    moved();
  }
  function activate(event: Event) {
    const control = (event.target as Element | null)?.closest?.(disclosures);
    if (control && content.contains(control)) hold(control);
  }
  function key(event: KeyboardEvent) {
    // Arrow keys switch tabs without a click.
    if (tabKeys.has(event.key) && (event.target as Element | null)?.closest?.('[role="tab"]'))
      activate(event);
  }
  function clear() {
    cancelAnimationFrame(frame);
    frame = 0;
    pending = undefined;
    resize(0);
  }
  const observer = new ResizeObserver(() => {
    if (!pending) trim();
  });
  observer.observe(content);
  observer.observe(scroller);
  // Capture runs before the control's own handlers change anything.
  scroller.addEventListener('click', activate, true);
  scroller.addEventListener('keydown', key, true);
  return {
    scrolled() {
      if (!height) return 'free';
      const before = height;
      trim();
      // Rounding to device pixels can trim a pixel without the reader moving.
      if (before - height > 1) return 'up';
      return height ? 'held' : 'free';
    },
    trim,
    clear,
    destroy() {
      clear();
      observer.disconnect();
      scroller.removeEventListener('click', activate, true);
      scroller.removeEventListener('keydown', key, true);
    },
  };
}
