import { defineConfig } from '@playwright/test';

/** `pnpm eval`: agent tasks against a real local model. Slow; never in CI. */
export default defineConfig({
  testDir: 'tests/eval',
  testMatch: '*.eval.ts',
  fullyParallel: false,
  workers: 1,
  // RUN_MINUTES (6) in agent.eval.ts plus setup and the wait for the run to end.
  timeout: 450_000,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
});
