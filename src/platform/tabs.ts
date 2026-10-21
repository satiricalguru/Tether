import { browser, type Browser } from 'wxt/browser';

/**
 * The page the user means by "this page". Normally the active tab; but when
 * the panel itself runs in a tab (the fallback where no side panel API
 * exists), that tab is ours, so use the most recently used other tab.
 */
export async function currentPageTab(): Promise<Browser.tabs.Tab | undefined> {
  const own = browser.runtime.getURL('/');
  const tabs = await browser.tabs.query({ currentWindow: true });
  const candidates = tabs.filter((t) => !(t.url ?? '').startsWith(own));
  const active = candidates.find((t) => t.active);
  if (active) return active;
  // Typed as always present, but missing before Chrome 121 and in Firefox.
  const last = (t: Browser.tabs.Tab) => (t.lastAccessed as number | undefined) ?? 0;
  return candidates.sort((a, b) => last(b) - last(a))[0];
}
