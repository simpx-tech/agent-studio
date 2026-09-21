import { defineConfig } from 'vitest/config';
const ci = !!process.env.CI;
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    maxWorkers: ci ? 1 : undefined,
    testTimeout: ci ? 15000 : 5000,
  },
});
