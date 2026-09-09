import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1380, height: 900 },
    channel: 'msedge',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
