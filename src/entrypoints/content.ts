import { defineContentScript } from 'wxt/utils/define-content-script';
import { installBubble, runtimeAlive } from '@/content/bubble';
import { extractPage } from '@/context/extract';
import { registerHandlers } from '@/lib/messaging';
import { getSettings, watchSettings } from '@/lib/settings';

/**
 * DOM bridge. Never declared for all sites in the manifest: it's injected on
 * demand (activeTab, a per-site grant) or registered dynamically on the
 * origins the user allowed once the highlight bubble is enabled.
 */

interface BridgeMarker {
  alive: () => boolean;
}

const MARKER = '__tetherBridge';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // Injected again (registration + on-demand, or after an extension
    // reload)? Keep a live instance; replace one orphaned by a reload.
    const scope = globalThis as unknown as Record<string, BridgeMarker | undefined>;
    if (scope[MARKER]?.alive()) return;
    scope[MARKER] = { alive: runtimeAlive };

    registerHandlers({
      'content:ping': () => ({ url: location.href, title: document.title }),
      'content:extract': ({ maxChars }) =>
        extractPage(document, window, maxChars === undefined ? {} : { maxChars }),
    });

    // Only the top frame gets a bubble; frames are read by the agent in Phase 5.
    if (window.top !== window) return;
    let bubbleOn = false;
    void getSettings().then((s) => {
      bubbleOn = s.page.bubble;
    });
    watchSettings((s) => {
      bubbleOn = s.page.bubble;
    });
    installBubble({ enabled: () => bubbleOn && runtimeAlive() });
  },
});
