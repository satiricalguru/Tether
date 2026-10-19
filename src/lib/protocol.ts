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

import type { ChatDone, ChatStreamEvent, ChatStreamRequest } from '@/background/chat';
import type { CandidateResult, ModelGroup, ProviderStatus } from '@/providers/registry';
import type { Capabilities, ModelInfo, ProviderConfig } from '@/providers/types';

export interface PingResponse {
  pong: true;
  version: string;
  at: number;
}

export interface MessageMap {
  'bg:ping': { req: undefined; res: PingResponse };
  'bg:open-options': { req: undefined; res: undefined };
  'bg:ensure-content-script': { req: { tabId: number }; res: { injected: boolean } };
  'bg:providers:status': { req: undefined; res: ProviderStatus[] };
  /** Probe well-known ports, add what answers to settings, return per-port results. */
  'bg:providers:discover': { req: undefined; res: CandidateResult[] };
  'bg:providers:models': { req: { instanceId: string }; res: ModelInfo[] };
  'bg:providers:all-models': { req: undefined; res: ModelGroup[] };
  'bg:providers:capabilities': {
    req: { instanceId: string; model: string };
    res: Capabilities;
  };
  'bg:providers:unload': { req: { instanceId: string; model: string }; res: undefined };
  /** Add or update a provider. The API key is write-only from the UI's side. */
  'bg:providers:save': {
    req: { config: Omit<ProviderConfig, 'apiKey'> & { apiKey?: string } };
    res: ProviderStatus[];
  };
  'bg:providers:remove': { req: { instanceId: string }; res: ProviderStatus[] };
  'bg:providers:reset-overrides': { req: { instanceId?: string }; res: undefined };
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
  /** One generation against a provider, with status events and metrics. */
  chat: {
    req: ChatStreamRequest;
    chunk: ChatStreamEvent;
    done: ChatDone;
  };
}

export type StreamName = keyof StreamMap;
export type StreamRequest<K extends StreamName> = StreamMap[K]['req'];
export type StreamChunk<K extends StreamName> = StreamMap[K]['chunk'];
export type StreamDone<K extends StreamName> = StreamMap[K]['done'];
