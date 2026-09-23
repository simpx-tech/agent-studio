import font from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import { visualizationDocument } from './visualizations';

// The font is bundled as data, so previews need no network/font-origin privileges.
// Keep Vite assets out of the shared schemas imported by the relay's Node runtime.
export function visualizationPreview(
  source: string,
  sizeToken?: string,
  theme: 'dark' | 'light' = 'dark',
) {
  return { type: 'studio-artifact', source: visualizationDocument(source, theme), font, sizeToken };
}
