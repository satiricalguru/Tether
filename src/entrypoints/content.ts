import { defineContentScript } from 'wxt/utils/define-content-script';
import { registerHandlers } from '@/lib/messaging';

/**
 * DOM bridge. Injected on demand (activeTab / scripting) rather than declared
 * for every site, so installing Tether doesn't require access to all sites.
 * Later phases add page extraction, the highlight bubble and action execution.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // Re-injection into a page that already has the bridge must be a no-op.
    const marker = '__tetherContentLoaded';
    const scope = globalThis as unknown as Record<string, boolean | undefined>;
    if (scope[marker]) return;
    scope[marker] = true;

    registerHandlers({
      'content:ping': () => ({ url: location.href, title: document.title }),
    });
  },
});
