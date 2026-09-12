import { defineConfig } from '@playwright/test';
const port = Number(process.env.STUDIO_TEST_PORT ?? 1420);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid STUDIO_TEST_PORT');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    viewport: { width: 1380, height: 900 },
    channel: 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
