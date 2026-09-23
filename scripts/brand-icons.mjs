// Regenerates every app icon from the Agent A mark: the SVG sources in static/,
// web and PWA PNGs, and the Tauri icon set (with hand-tuned 16–32px Windows icons).
// Usage from the repository root: node scripts/brand-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const ink = '#ededf0';
const accent = '#c4e88c';

// The mark on a 64-unit grid. Smaller icons use heavier variants: the crossbar
// is dropped at 16px, where it would merge with the frame.
const marks = {
  regular: `<path d="M12 56 L32 25 L52 56" fill="none" stroke="${ink}" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="10.5" r="7" fill="${accent}"/><path d="M23.5 45 H40.5" fill="none" stroke="${accent}" stroke-width="5.5" stroke-linecap="round"/>`,
  small: `<path d="M11.5 57 L32 28.5 L52.5 57" fill="none" stroke="${ink}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="11" r="8.5" fill="${accent}"/><path d="M24.5 47.5 H39.5" fill="none" stroke="${accent}" stroke-width="7" stroke-linecap="round"/>`,
  tiny: `<path d="M11.5 57 L32 28.5 L52.5 57" fill="none" stroke="${ink}" stroke-width="11.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="11" r="9.5" fill="${accent}"/>`,
};

const defs = `<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#202025"/><stop offset="1" stop-color="#0c0c0e"/></linearGradient><radialGradient id="glow" cx="0.5" cy="0.3" r="0.75"><stop offset="0" stop-color="${accent}" stop-opacity="0.13"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>`;

// A rounded tile for desktop icons and favicons, or a full-bleed square that phone
// launchers mask themselves. The regular mark stays inside the maskable safe zone.
function icon({ mark = 'regular', rounded = true } = {}) {
  const radius = rounded ? 116 : 0;
  const span = mark === 'regular' ? 300 : 390;
  const offset = (512 - span) / 2;
  const edge = rounded
    ? '<rect x="2" y="2" width="508" height="508" rx="114" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="4"/>'
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${defs}<rect width="512" height="512" rx="${radius}" fill="url(#tile)"/><rect width="512" height="512" rx="${radius}" fill="url(#glow)"/>${edge}<g transform="translate(${offset} ${offset}) scale(${span / 64})">${marks[mark]}</g></svg>\n`;
}

// An ICO file with PNG entries, in the order Tauri writes them.
function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map(({ png }) => png)]);
}

writeFileSync('static/agent-studio.svg', icon());
writeFileSync('static/favicon.svg', icon({ mark: 'small' }));

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`,
  );
  return page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
}

writeFileSync('static/favicon.png', await render(icon({ mark: 'small' }), 128));
for (const [file, size] of [
  ['static/icons/icon-192.png', 192],
  ['static/icons/icon-512.png', 512],
  ['static/icons/apple-touch-icon.png', 180],
])
  writeFileSync(file, await render(icon({ rounded: false }), size));

const master = 'artifacts/brand/master-1024.png';
mkdirSync('artifacts/brand', { recursive: true });
writeFileSync(master, await render(icon(), 1024));
const windowsIcon = ico([
  { size: 32, png: await render(icon({ mark: 'small' }), 32) },
  { size: 16, png: await render(icon({ mark: 'tiny' }), 16) },
  { size: 24, png: await render(icon({ mark: 'small' }), 24) },
  { size: 48, png: await render(icon(), 48) },
  { size: 64, png: await render(icon(), 64) },
  { size: 256, png: await render(icon(), 256) },
]);
const small32 = await render(icon({ mark: 'small' }), 32);
await browser.close();

// Tauri writes the desktop, Windows Store, macOS, iOS and Android icons from the
// master; the small Windows sizes then use the tuned variants.
execFileSync(
  process.execPath,
  ['node_modules/@tauri-apps/cli/tauri.js', 'icon', master, '--ios-color', '#0c0c0e'],
  { stdio: 'inherit' },
);
writeFileSync('src-tauri/icons/icon.ico', windowsIcon);
writeFileSync('src-tauri/icons/32x32.png', small32);
console.log('Brand icons regenerated.');
