import { defineConfig } from 'vitest/config';
import { changelog } from './vite.config.js';
const ci = !!process.env.CI;
export default defineConfig({
  plugins: [changelog()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    maxWorkers: ci ? 1 : undefined,
    testTimeout: ci ? 15000 : 5000,
  },
});
