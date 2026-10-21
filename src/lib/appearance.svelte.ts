// Device-local appearance. Dark is the default; Light and System select the same
// design tokens through the root data-theme attribute (see theme.css).
import { tick } from 'svelte';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const storageKey = 'agent-studio.theme';
const chromeColors: Record<ResolvedTheme, string> = { dark: '#111113', light: '#ffffff' };

export const appearance = $state<{ preference: ThemePreference; resolved: ResolvedTheme }>({
  preference: 'dark',
  resolved: 'dark',
});

let systemLight: MediaQueryList | undefined;

function resolve(): ResolvedTheme {
  return appearance.preference === 'system'
    ? systemLight?.matches
      ? 'light'
      : 'dark'
    : appearance.preference;
}

function apply() {
  const resolved = resolve();
  appearance.resolved = resolved;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', chromeColors[resolved]);
}

// A theme chosen later, or the system's changing under System, crosses over from the old
// colours instead of flashing (styles.css times it). It applies at once when the colours stay,
// in a hidden window, under reduced motion and in engines without view transitions.
function change() {
  if (
    resolve() === document.documentElement.dataset.theme ||
    typeof document.startViewTransition !== 'function' ||
    document.visibilityState !== 'visible' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return apply();
  document
    .startViewTransition(() => {
      apply();
      // Components reading the theme update before the new colours are captured.
      return tick();
    })
    .ready.catch(() => {
      // A transition the browser skips still applies the theme.
    });
}

export function initAppearance() {
  if (typeof window === 'undefined') return;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'dark' || saved === 'light' || saved === 'system') appearance.preference = saved;
  } catch {
    // Storage can be unavailable in private windows; the default theme still applies.
  }
  if (!systemLight) {
    systemLight = window.matchMedia('(prefers-color-scheme: light)');
    systemLight.addEventListener('change', () => {
      if (appearance.preference === 'system') change();
    });
  }
  apply();
}

export function setThemePreference(preference: ThemePreference) {
  appearance.preference = preference;
  try {
    localStorage.setItem(storageKey, preference);
  } catch {
    // The choice still applies for this session.
  }
  change();
}
