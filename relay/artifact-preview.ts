import { readFileSync } from 'node:fs';

// The sandbox visualizations and screens render in: nothing loads from the network.
export const artifactPreviewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
// The sandbox artifact pages render in (requested 2026-10-14): the same, except that scripts,
// stylesheets and fonts also load from three CDNs, at the versions a page pins, and Google
// Fonts, as Claude Code's artifact viewer allows. A page still makes no request of its own.
// src-tauri/src/artifacts.rs keeps the same two policies for the desktop renderer.
export const artifactPageCsp =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.googleapis.com; img-src data: blob:; font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.gstatic.com; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export const artifactPreviewHtml = readFileSync(
  new URL('../src/lib/artifact-preview.html', import.meta.url),
);
const headers = (policy: string) => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': policy,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});
export const artifactPreviewHeaders = headers(artifactPreviewCsp);
export const artifactPageHeaders = headers(artifactPageCsp);
