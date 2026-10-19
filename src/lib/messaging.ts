import { browser, type Browser } from 'wxt/browser';
import { deserializeError, serializeError, type SerializedError } from './errors';
import type { MessageRequest, MessageResponse, MessageType } from './protocol';

const TAG = '__tether';

export interface Envelope<K extends MessageType = MessageType> {
  [TAG]: 1;
  type: K;
  payload: MessageRequest<K>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

export type MessageSender = Browser.runtime.MessageSender;

export type Handler<K extends MessageType> = (
  payload: MessageRequest<K>,
  sender: MessageSender,
) => MessageResponse<K> | Promise<MessageResponse<K>>;

export type HandlerMap = { [K in MessageType]?: Handler<K> };

export function isEnvelope(msg: unknown): msg is Envelope {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as Record<string, unknown>)[TAG] === 1 &&
    typeof (msg as Record<string, unknown>).type === 'string'
  );
}

function envelope<K extends MessageType>(type: K, payload: MessageRequest<K>): Envelope<K> {
  return { [TAG]: 1, type, payload };
}

function unwrap(type: string, result: unknown): unknown {
  if (result === undefined) {
    throw new Error(`No handler responded to "${type}"`);
  }
  const r = result as Result<unknown>;
  if (r.ok) return r.value;
  throw deserializeError(r.error);
}

type Args<K extends MessageType> =
  MessageRequest<K> extends undefined
    ? [payload?: MessageRequest<K>]
    : [payload: MessageRequest<K>];

/** Send a request to the extension runtime (background, offscreen, extension pages). */
export async function sendMessage<K extends MessageType>(
  type: K,
  ...[payload]: Args<K>
): Promise<MessageResponse<K>> {
  const result: unknown = await browser.runtime.sendMessage(
    envelope(type, payload as MessageRequest<K>),
  );
  return unwrap(type, result) as MessageResponse<K>;
}

/** Send a request to the content script in a tab (optionally a specific frame). */
export async function sendToTab<K extends MessageType>(
  tabId: number,
  type: K,
  payload: MessageRequest<K>,
  frameId?: number,
): Promise<MessageResponse<K>> {
  const result: unknown = await browser.tabs.sendMessage(
    tabId,
    envelope(type, payload),
    frameId === undefined ? undefined : { frameId },
  );
  return unwrap(type, result) as MessageResponse<K>;
}

/**
 * Register handlers for a set of message types. Messages this router has no
 * handler for are ignored (the listener returns `undefined`) so another
 * context can answer them. Handler errors are returned as `{ok:false}` rather
 * than leaking as an unanswered message.
 *
 * Returns an unsubscribe function.
 */
export function registerHandlers(handlers: HandlerMap): () => void {
  const listener = (
    msg: unknown,
    sender: MessageSender,
    sendResponse: (response: Result<unknown>) => void,
  ): true | undefined => {
    if (!isEnvelope(msg)) return undefined;
    const handler = handlers[msg.type] as Handler<MessageType> | undefined;
    if (!handler) return undefined;

    Promise.resolve()
      .then(() => handler(msg.payload as never, sender))
      .then(
        (value) => {
          sendResponse({ ok: true, value });
        },
        (err: unknown) => {
          sendResponse({ ok: false, error: serializeError(err) });
        },
      );
    // Keep the channel open for the async response.
    return true;
  };

  browser.runtime.onMessage.addListener(listener);
  return () => {
    browser.runtime.onMessage.removeListener(listener);
  };
}
