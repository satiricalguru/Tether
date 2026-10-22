import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../..',
  process.env.TETHER_OUT_DIR ?? '.output',
  'chrome-mv3',
);

export default function globalSetup(): void {
  if (!existsSync(resolve(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(
      `No extension build at ${EXTENSION_PATH}. Run "pnpm build" first (or use "pnpm e2e", which builds).`,
    );
  }
}
