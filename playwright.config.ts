import { defineConfig } from '@playwright/test';
const port = Number(process.env.STUDIO_TEST_PORT ?? 1420);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid STUDIO_TEST_PORT');
const baseURL = `http://127.0.0.1:${port}`;
const ci = !!process.env.CI;
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: ci ? 1 : 4,
  // Hosted Windows screenshots and browser actions can exceed the local budget.
  timeout: ci ? 60000 : 30000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    viewport: { width: 1380, height: 900 },
    channel: 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: {
    // CI verifies the built app without dev dependency optimization or HMR races.
    command: ci
      ? `npm run preview -- --host 127.0.0.1 --port ${port}`
      : `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !ci,
    timeout: 30000,
  },
});
