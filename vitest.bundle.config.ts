import { defineConfig } from 'vitest/config';

/** Checks over the built extension in .output/; run after `pnpm build`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bundle/**/*.test.ts'],
  },
});
