// Device-local appearance. Dark is the default; Light and System select the same
// design tokens through the root data-theme attribute (see theme.css).
export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';
/**
 * Which part of an ordinary chat is a card on the workspace (requested 2026-10-19, to choose
 * between): its toolbar, or its conversation below a toolbar on the workspace.
 */
export type ChatCard = 'header' | 'chat';

const storageKey = 'agent-studio.theme';
const chatCardKey = 'agent-studio.chat-card';
const chromeColors: Record<ResolvedTheme, string> = { dark: '#111113', light: '#ffffff' };

export const appearance = $state<{
  preference: ThemePreference;
  resolved: ResolvedTheme;
  chatCard: ChatCard;
}>({
  preference: 'dark',
  resolved: 'dark',
  chatCard: 'chat',
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
    const card = localStorage.getItem(chatCardKey);
    if (card === 'header' || card === 'chat') appearance.chatCard = card;
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

export function setChatCard(card: ChatCard) {
  appearance.chatCard = card;
  try {
    localStorage.setItem(chatCardKey, card);
  } catch {
    // The choice still applies for this session.
  }
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
