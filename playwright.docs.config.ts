import { defineConfig } from '@playwright/test';

/** `pnpm docs:media`: README screenshots and demo GIF (docs/images). Never in CI. */
export default defineConfig({
  testDir: 'tests/docs',
  testMatch: '*.docs.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
});
