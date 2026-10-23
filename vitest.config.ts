import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/helpers/setup.ts'],
    restoreMocks: true,
    // Correct but heavy tests (exhaustive stream splits, full panel renders)
    // shouldn't fail on a busy machine; 5 s flaked while an eval was running.
    testTimeout: 15_000,
  },
});
