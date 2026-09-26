import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { artifactPreviewHtml, artifactPreviewHeaders } from './relay/artifact-preview.ts';
const host = process.env.TAURI_DEV_HOST;

/**
 * Provides the root CHANGELOG.md as the text module `virtual:changelog` for Settings → About.
 * SvelteKit's dev server reads only files under src and node_modules.
 * @returns {import('vite').Plugin}
 */
export function changelog() {
  const id = 'virtual:changelog';
  const file = fileURLToPath(new URL('./CHANGELOG.md', import.meta.url));
  return {
    name: 'changelog',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(source) {
      if (source !== `\0${id}`) return;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    sveltekit(),
    changelog(),
    {
      name: 'artifact-preview',
      configureServer(server) {
        server.middlewares.use('/artifact-preview', (_req, res) => {
          res.writeHead(200, artifactPreviewHeaders);
          res.end(artifactPreviewHtml);
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use('/artifact-preview', (_req, res) => {
          res.writeHead(200, artifactPreviewHeaders);
          res.end(artifactPreviewHtml);
        });
      },
    },
  ],

  // The 3D viewer loads three.js only for a reply that shows a model. Pre-bundling it with
  // the other dependencies keeps that first model from reloading the page mid-render.
  optimizeDeps: {
    include: [
      'three',
      'three/examples/jsm/controls/OrbitControls.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/FBXLoader.js',
      'three/examples/jsm/loaders/OBJLoader.js',
      'three/examples/jsm/loaders/STLLoader.js',
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**', '**/artifacts/**', '**/test-results/**', '**/.relay-data/**'],
    },
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.relay-data/**', '**/artifacts/**'],
    },
  },
}));
