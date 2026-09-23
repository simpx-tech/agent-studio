// Device-local appearance. Dark is the default; Light and System select the same
// design tokens through the root data-theme attribute (see theme.css).
export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const storageKey = 'agent-studio.theme';
const chromeColors: Record<ResolvedTheme, string> = { dark: '#111113', light: '#ffffff' };

export const appearance = $state<{ preference: ThemePreference; resolved: ResolvedTheme }>({
  preference: 'dark',
  resolved: 'dark',
});

let systemLight: MediaQueryList | undefined;

function apply() {
  const resolved: ResolvedTheme =
    appearance.preference === 'system'
      ? systemLight?.matches
        ? 'light'
        : 'dark'
      : appearance.preference;
  appearance.resolved = resolved;
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', chromeColors[resolved]);
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
      if (appearance.preference === 'system') apply();
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
  apply();
}
