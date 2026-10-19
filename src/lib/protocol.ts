/**
 * The single source of truth for every message that crosses an extension
 * context boundary. Request/response messages live in `MessageMap`; streamed
 * exchanges over a `runtime.Port` live in `StreamMap`.
 *
 * Message types are namespaced by the context that *handles* them:
 *   bg:*        background service worker
 *   content:*   content script (sent with tabs.sendMessage)
 *   offscreen:* offscreen document
 * A context only answers its own namespace, so several listeners on
 * runtime.onMessage never race to respond.
 */

export interface PingResponse {
  pong: true;
  version: string;
  at: number;
}

export interface MessageMap {
  'bg:ping': { req: undefined; res: PingResponse };
  'bg:open-options': { req: undefined; res: undefined };
  'bg:ensure-content-script': { req: { tabId: number }; res: { injected: boolean } };
  'content:ping': { req: undefined; res: { url: string; title: string } };
  'offscreen:ping': { req: undefined; res: PingResponse };
}

export type MessageType = keyof MessageMap;
export type MessageRequest<K extends MessageType> = MessageMap[K]['req'];
export type MessageResponse<K extends MessageType> = MessageMap[K]['res'];

export interface StreamMap {
  /**
   * Transport check: echoes `text` back one token at a time. Exercises the
   * full port path (chunking, abort, completion) without a model.
   */
  echo: {
    req: { text: string; delayMs?: number };
    chunk: { token: string; index: number };
    done: { count: number };
  };
}

export type StreamName = keyof StreamMap;
export type StreamRequest<K extends StreamName> = StreamMap[K]['req'];
export type StreamChunk<K extends StreamName> = StreamMap[K]['chunk'];
export type StreamDone<K extends StreamName> = StreamMap[K]['done'];
