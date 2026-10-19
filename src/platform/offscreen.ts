import { browser, type Browser } from 'wxt/browser';
import { platform } from './capabilities';

const OFFSCREEN_PATH = '/offscreen.html';

let creating: Promise<void> | undefined;

/**
 * Ensure the single offscreen document exists. Returns false where offscreen
 * documents don't exist (Firefox), in which case callers do the work in the
 * background page directly — Firefox's background page has a DOM.
 */
export async function ensureOffscreen(
  reasons: `${Browser.offscreen.Reason}`[],
  justification: string,
): Promise<boolean> {
  if (!platform.offscreen) return false;

  const url = browser.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length > 0) return true;

  // createDocument rejects if a second call races the first.
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons,
      justification,
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
  return true;
}

export async function closeOffscreen(): Promise<void> {
  if (!platform.offscreen) return;
  if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument();
}
