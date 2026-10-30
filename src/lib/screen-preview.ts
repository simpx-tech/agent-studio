import font from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import { screenDocument } from './screens';

// The font is bundled as data, so screens need no network or font-origin privileges. Kept apart
// from the shared schemas, which the relay's Node runtime imports without Vite.
export function screenPreview(
  source: string,
  token: string,
  screen: { id: string; title: string },
  theme: 'dark' | 'light' = 'dark',
  values: Record<string, unknown> = {},
  shell: 'powershell' | 'bash' = 'powershell',
) {
  return {
    type: 'studio-artifact',
    source: screenDocument(source, token, screen, theme, values, shell),
    font,
    page: true,
  };
}
