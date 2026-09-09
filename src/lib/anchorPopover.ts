// A top-layer popover escapes the horizontally scrolling settings toolbar and
// modal clipping, while remaining in the trigger's DOM/accessibility scope.
export function anchorPopover(node: HTMLElement, trigger: HTMLElement) {
  node.showPopover();
  const viewport = window.visualViewport;
  let frame = 0;
  function position() {
    frame = 0;
    const anchor = trigger.getBoundingClientRect();
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const margin = 8;
    const gap = 6;
    const panelWidth = Math.min(Math.max(288, anchor.width), width - margin * 2);
    node.style.width = `${panelWidth}px`;
    const below = Math.max(0, top + height - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - gap - top - margin);
    const naturalHeight = Math.min(
      400,
      node.firstElementChild!.getBoundingClientRect().height +
        node.lastElementChild!.scrollHeight +
        14,
    );
    const openAbove = below < naturalHeight && above > below;
    node.style.maxHeight = `${openAbove ? above : below}px`;
    const panelHeight = node.getBoundingClientRect().height;
    node.style.left = `${Math.max(left + margin, Math.min(anchor.left, left + width - panelWidth - margin))}px`;
    node.style.top = `${openAbove ? anchor.top - gap - panelHeight : anchor.bottom + gap}px`;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(position);
  }
  position();
  const observer = new ResizeObserver(schedule);
  observer.observe(trigger);
  // Option/model catalogs can finish loading while a picker is open.
  observer.observe(node.firstElementChild!);
  observer.observe(node.lastElementChild!);
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  return {
    destroy() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
    },
  };
}
