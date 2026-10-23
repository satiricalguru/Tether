import { browser, type Browser } from 'wxt/browser';
import { sendMessage, type Handler, type MessageSender } from '@/lib/messaging';
import type { MessageRequest, MessageResponse, MessageType } from '@/lib/protocol';
import { OFFSCREEN_HANDLERS } from '@/offscreen/handlers';
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

export type OffscreenMessage = Extract<MessageType, `offscreen:${string}`>;

/**
 * Run an `offscreen:*` handler wherever this browser has a DOM for it: in
 * the offscreen document (Chromium, created on demand), or in place in the
 * background page (Firefox).
 */
export async function callOffscreen<K extends OffscreenMessage>(
  type: K,
  payload: MessageRequest<K>,
  why: { reasons: `${Browser.offscreen.Reason}`[]; justification: string },
): Promise<MessageResponse<K>> {
  if (await ensureOffscreen(why.reasons, why.justification)) {
    return (sendMessage as (t: K, p: MessageRequest<K>) => Promise<MessageResponse<K>>)(
      type,
      payload,
    );
  }
  const handler: Handler<K> | undefined = OFFSCREEN_HANDLERS[type];
  if (!handler) throw new Error(`No offscreen handler for ${type}`);
  const self: MessageSender = { id: browser.runtime.id };
  return handler(payload, self);
}
