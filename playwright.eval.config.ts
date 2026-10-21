import { defineConfig } from '@playwright/test';

/** `pnpm eval`: agent tasks against a real local model. Slow; never in CI. */
export default defineConfig({
  testDir: 'tests/eval',
  testMatch: '*.eval.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
});
