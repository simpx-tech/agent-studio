import { readFileSync } from 'node:fs';

export const artifactPreviewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export const artifactPreviewHtml = readFileSync(
  new URL('../src/lib/artifact-preview.html', import.meta.url),
);
export const artifactPreviewHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': artifactPreviewCsp,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
