import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import process from 'node:process';
import { artifactPreviewHtml, artifactPreviewHeaders } from './relay/artifact-preview.ts';
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    sveltekit(),
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
