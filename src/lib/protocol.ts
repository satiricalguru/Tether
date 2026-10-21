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
import type { Attachment } from '@/context/attachments';
import type { PageExtract } from '@/context/extract';
import type { QuickAction } from '@/prompting/actions';
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
  /** Extract a tab's readable content (injects the bridge if needed). */
  'bg:context:page': { req: { tabId: number }; res: PageExtract };
  /** Tabs in the current window, with whether Tether may read them. */
  'bg:context:tabs': { req: { windowId?: number }; res: TabSummary[] };
  /** From the highlight bubble: carry an inline answer into the side panel. */
  'bg:pending:continue': {
    req: { selection: string; prompt: string; answer: string; url: string; title: string };
    res: { opened: boolean };
  };
  'content:ping': { req: undefined; res: { url: string; title: string } };
  'content:extract': { req: { maxChars?: number }; res: PageExtract };
  'offscreen:ping': { req: undefined; res: PingResponse };
}

export type TabAccess = 'granted' | 'needs-permission' | 'restricted';

export interface TabSummary {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  access: TabAccess;
  isPdf: boolean;
}

/** Work queued for the side panel by a context menu or the bubble (storage.session). */
export type PendingAction =
  | { id: string; kind: 'ask'; prompt: string; attachments: Attachment[]; createdAt: number }
  | { id: string; kind: 'attach-page'; tabId: number; createdAt: number }
  | {
      id: string;
      kind: 'continue';
      prompt: string;
      answer: string;
      attachments: Attachment[];
      createdAt: number;
    };

export const PENDING_KEY = 'tether:pending';

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
  /** A one-shot action on selected text, run entirely in the background. */
  quick: {
    req: { action: QuickAction; selection: string; question?: string; url: string; title: string };
    chunk: ChatStreamEvent;
    done: ChatDone & { prompt: string };
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
