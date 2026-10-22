import { defineContentScript } from 'wxt/utils/define-content-script';
import { hideBanner, showBanner } from '@/content/banner';
import { pageHandlers } from '@/agent/page/handlers';
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

/** Resolve when `text` is visible in the page (case-insensitive), or after the timeout. */
function waitForText(text: string, timeoutMs: number): Promise<{ found: boolean }> {
  const needle = text.trim().toLowerCase();
  const present = () => document.body.innerText.toLowerCase().includes(needle);
  if (!needle || present()) return Promise.resolve({ found: !!needle });
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (present()) {
        cleanup();
        resolve({ found: true });
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      resolve({ found: false });
    }, timeoutMs);
    function cleanup() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

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
      'content:wait-text': ({ text, timeoutMs }) => waitForText(text, timeoutMs),
      ...pageHandlers(),
      'content:agent-banner': ({ on, runId }) => {
        if (window.top !== window) return undefined;
        if (on) showBanner(runId);
        else hideBanner();
        return undefined;
      },
    });

    // Only the top frame gets a bubble (and the agent banner).
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
