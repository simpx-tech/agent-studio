// iOS resizes AND pans the visual viewport for the keyboard. Keep the fixed
// shell in that coordinate space; a height alone makes the composer jump.
export function trackMobileViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 650px)');
  const standalone = window.matchMedia('(display-mode: standalone)');
  let frame = 0;
  let settlingUntil = 0;

  function reset() {
    root.style.removeProperty('--mobile-height');
    root.style.removeProperty('--mobile-top');
    root.classList.remove('mobile-keyboard');
  }
  function update() {
    frame = 0;
    if (!mobile.matches) {
      reset();
      return;
    }
    // Pinch zoom is not a keyboard resize. Leave zoom and panning to the user.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const height = viewport?.height ?? window.innerHeight;
    const keyboard = root.clientHeight - height > 100;
    if (keyboard) {
      root.style.setProperty('--mobile-height', `${height}px`);
      root.style.setProperty('--mobile-top', `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
      root.classList.add('mobile-keyboard');
    } else {
      reset();
      if (
        standalone.matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
      ) {
        // Installed Safari can report dvh/percentage heights without the safe
        // areas even with viewport-fit=cover. Use the full window/large viewport
        // for every surface; keep safe-area padding INSIDE that shared height.
        // Browser tabs retain dvh so their real navigation bars stay respected.
        root.style.setProperty(
          '--mobile-height',
          `max(100vh, 100dvh, ${Math.max(window.innerHeight, root.clientHeight)}px)`,
        );
      }
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    }
    if (performance.now() < settlingUntil) frame = requestAnimationFrame(update);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  function settle() {
    // Safari can report its final geometry after the focus/resize event.
    settlingUntil = performance.now() + 700;
    schedule();
  }
  viewport?.addEventListener('resize', settle);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', settle);
  window.addEventListener('scroll', schedule);
  window.addEventListener('pageshow', settle);
  document.addEventListener('focusin', settle);
  document.addEventListener('focusout', settle);
  document.addEventListener('visibilitychange', settle);
  mobile.addEventListener('change', settle);
  standalone.addEventListener('change', settle);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', settle);
    viewport?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', settle);
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('pageshow', settle);
    document.removeEventListener('focusin', settle);
    document.removeEventListener('focusout', settle);
    document.removeEventListener('visibilitychange', settle);
    mobile.removeEventListener('change', settle);
    standalone.removeEventListener('change', settle);
    reset();
  };
}
