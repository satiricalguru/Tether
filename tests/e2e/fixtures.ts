import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { startStaticServer } from '../fixtures/static-server';
import { EXTENSION_PATH } from './global-setup';

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  extensionUrl: (path: string) => string;
}

interface WorkerFixtures {
  sitesUrl: string;
}

/**
 * Launches Chromium with the unpacked build loaded into a fresh persistent
 * profile. `channel: 'chromium'` uses the new headless mode, which (unlike
 * the headless shell) can load extensions.
 */
export const test = base.extend<Fixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: process.env.HEADED !== '1',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  extensionUrl: async ({ extensionId }, use) => {
    await use((path) => `chrome-extension://${extensionId}/${path.replace(/^\//, '')}`);
  },
  sitesUrl: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
    async ({}, use) => {
      const server = await startStaticServer(resolve(import.meta.dirname, '../fixtures/sites'));
      await use(server.url);
      await server.close();
    },
    { scope: 'worker' },
  ],
});

export const expect = test.expect;
